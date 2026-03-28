require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();

// ── CORS: allow Netlify frontend ──────────────────────────────────────────────
app.use(cors({
  origin: ['https://gtic-apply.netlify.app', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json());

// ── SESSION ───────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'gtic2026supersecretkey123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,        // Railway uses HTTPS
    sameSite: 'none',    // cross-site (Netlify → Railway)
    maxAge: 1000 * 60 * 60 * 2  // 2 hours
  }
}));

// ── DISCORD BOT CLIENT ────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.login(process.env.TOKEN);
client.once('ready', () => console.log(`✅ Bot ready as ${client.user.tag}`));

// ── CHANNEL MAP ───────────────────────────────────────────────────────────────
const CHANNELS = {
  'Caster':           process.env.CHANNEL_CASTER,
  'Referee':          process.env.CHANNEL_REFEREE,
  'Commentator':      process.env.CHANNEL_COMMENTATOR,
  'League Manager':   process.env.CHANNEL_LEAGUE_MANAGER,
  'Trial Moderator':  process.env.CHANNEL_TRIAL_MOD,
  'Graphic Designer': process.env.CHANNEL_GRAPHIC_DESIGNER,
  'Media Team':       process.env.CHANNEL_MEDIA_TEAM,
};

// ── OAUTH2: Step 1 — redirect to Discord ─────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const url = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=identify`;
  res.redirect(url);
});

// ── OAUTH2: Step 2 — handle callback from Discord ────────────────────────────
app.post('/auth/callback', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).json({ error: 'Failed to get access token' });

    // Get user info from Discord
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    // Get guild member info (join date etc.)
    let memberData = null;
    try {
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const member = await guild.members.fetch(userData.id);
      memberData = {
        joinedAt: member.joinedAt,
        displayName: member.displayName,
        mention: `<@${userData.id}>`
      };
    } catch (e) {
      console.log('Could not fetch guild member:', e.message);
    }

    // Save to session
    req.session.user = {
      id: userData.id,
      username: userData.username,
      discriminator: userData.discriminator,
      avatar: userData.avatar,
      joinedAt: memberData?.joinedAt || null,
      mention: memberData?.mention || `<@${userData.id}>`
    };

    res.json({ success: true, user: req.session.user });
  } catch (err) {
    console.error('OAuth2 error:', err);
    res.status(500).json({ error: 'OAuth2 failed' });
  }
});

// ── GET current logged in user ────────────────────────────────────────────────
app.get('/auth/user', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.session.user });
});

// ── LOGOUT ────────────────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── SUBMIT APPLICATION ────────────────────────────────────────────────────────
app.post('/apply', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });

  const { role, answers } = req.body;
  if (!role || !answers) return res.status(400).json({ error: 'Missing role or answers' });

  const channelId = CHANNELS[role];
  if (!channelId) return res.status(400).json({ error: 'Invalid role' });

  const user = req.session.user;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    // Build the message content matching your existing bot's style
    const now = new Date();
    const timeStr = now.toLocaleString('en-US', { 
      month: 'numeric', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true 
    });

    // Format join date
    let joinedStr = 'Unknown';
    if (user.joinedAt) {
      const joined = new Date(user.joinedAt);
      const diffMs = Date.now() - joined.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays < 1) joinedStr = 'Today';
      else if (diffDays === 1) joinedStr = '1 day ago';
      else if (diffDays < 30) joinedStr = `${diffDays} days ago`;
      else if (diffDays < 365) joinedStr = `${Math.floor(diffDays/30)} months ago`;
      else joinedStr = `${Math.floor(diffDays/365)} years ago`;
    }

    // Build answer lines
    let answerText = '';
    answers.forEach((a, i) => {
      answerText += `**${i + 1}. ${a.question}**\n${a.answer || '_No answer_'}\n\n`;
    });

    // Build full message
    const messageContent = 
      `**${user.username}'s '${role}' Application Submitted**\n\n` +
      answerText +
      `**Submission Stats**\n` +
      `UserId: ${user.id}\n` +
      `Username: ${user.username}\n` +
      `User: <@${user.id}>\n` +
      `Joined guild: ${joinedStr}\n` +
      `Submitted: Just now`;

    // Buttons: Accept, Deny, Accept with reason, Deny with reason, History
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`app_accept_${user.id}_${role.replace(/ /g,'_')}`)
        .setLabel('Accept')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`app_deny_${user.id}_${role.replace(/ /g,'_')}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`app_acceptr_${user.id}_${role.replace(/ /g,'_')}`)
        .setLabel('Accept with reason')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`app_denyr_${user.id}_${role.replace(/ /g,'_')}`)
        .setLabel('Deny with reason')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`app_history_${user.id}`)
        .setLabel('History')
        .setStyle(ButtonStyle.Secondary),
    );

    await channel.send({ content: messageContent, components: [row] });

    // Handle button interactions for accept/deny
    res.json({ success: true });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to post application' });
  }
});

// ── BUTTON INTERACTION HANDLER ────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const id = interaction.customId;
  if (!id.startsWith('app_')) return;

  const parts = id.split('_');
  const action = parts[1]; // accept, deny, acceptr, denyr, history
  const userId = parts[2];
  const reviewer = interaction.user;

  try {
    if (action === 'accept') {
      await interaction.message.edit({
        components: [],
        content: interaction.message.content
      });
      await interaction.message.reply({ content: `✅ Accepted by ${reviewer.username}.` });
      await interaction.reply({ content: '✅ Application accepted!', ephemeral: true });

      // DM the applicant
      try {
        const discordUser = await client.users.fetch(userId);
        await discordUser.send(`✅ Your **${parts.slice(3).join(' ')}** application for GTIC has been **accepted**! Welcome to the team.`);
      } catch (e) {}

    } else if (action === 'deny') {
      await interaction.message.edit({ components: [], content: interaction.message.content });
      await interaction.message.reply({ content: `❌ Denied by ${reviewer.username}.` });
      await interaction.reply({ content: '❌ Application denied.', ephemeral: true });

      try {
        const discordUser = await client.users.fetch(userId);
        await discordUser.send(`❌ Your **${parts.slice(3).join(' ')}** application for GTIC has been **denied**. You may reapply in the future.`);
      } catch (e) {}

    } else if (action === 'acceptr') {
      await interaction.showModal({
        title: 'Accept with Reason',
        custom_id: `modal_acceptr_${userId}_${parts.slice(3).join('_')}`,
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: 'reason',
            label: 'Reason',
            style: 2,
            placeholder: 'Enter reason for acceptance...',
            required: true
          }]
        }]
      });

    } else if (action === 'denyr') {
      await interaction.showModal({
        title: 'Deny with Reason',
        custom_id: `modal_denyr_${userId}_${parts.slice(3).join('_')}`,
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: 'reason',
            label: 'Reason',
            style: 2,
            placeholder: 'Enter reason for denial...',
            required: true
          }]
        }]
      });

    } else if (action === 'history') {
      await interaction.reply({ content: `📋 Viewing history for <@${userId}> — (history feature coming soon)`, ephemeral: true });
    }

  } catch (err) {
    console.error('Button error:', err);
    if (!interaction.replied) await interaction.reply({ content: '❌ Error processing action.', ephemeral: true });
  }
});

// ── MODAL SUBMIT HANDLER ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  const id = interaction.customId;
  if (!id.startsWith('modal_')) return;

  const parts = id.split('_');
  const action = parts[1]; // acceptr or denyr
  const userId = parts[2];
  const roleName = parts.slice(3).join(' ');
  const reason = interaction.fields.getTextInputValue('reason');
  const reviewer = interaction.user;

  try {
    if (action === 'acceptr') {
      await interaction.message.edit({ components: [], content: interaction.message.content });
      await interaction.message.reply({ content: `✅ Accepted by ${reviewer.username} — *${reason}*` });
      await interaction.reply({ content: '✅ Application accepted!', ephemeral: true });
      try {
        const discordUser = await client.users.fetch(userId);
        await discordUser.send(`✅ Your **${roleName}** application for GTIC has been **accepted**!\n**Reason:** ${reason}`);
      } catch (e) {}

    } else if (action === 'denyr') {
      await interaction.message.edit({ components: [], content: interaction.message.content });
      await interaction.message.reply({ content: `❌ Denied by ${reviewer.username} — *${reason}*` });
      await interaction.reply({ content: '❌ Application denied.', ephemeral: true });
      try {
        const discordUser = await client.users.fetch(userId);
        await discordUser.send(`❌ Your **${roleName}** application for GTIC has been **denied**.\n**Reason:** ${reason}`);
      } catch (e) {}
    }
  } catch (err) {
    console.error('Modal error:', err);
    if (!interaction.replied) await interaction.reply({ content: '❌ Error.', ephemeral: true });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 GTIC Apply server running on port ${PORT}`));
