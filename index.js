const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
  PermissionFlagsBits
} = require('discord.js');
const axios = require('axios');
const http = require('http');
const mongoose = require('mongoose');
require('dotenv').config();

// Web server workaround to keep Render alive 24/7
http.createServer((req, res) => {
  res.write("AniTracker is running!");
  res.end();
}).listen(process.env.PORT || 3000);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas!'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define Schemas
const TrackSchema = new mongoose.Schema({
  guildId: String,
  channelId: String,
  animeId: Number,
  animeTitle: String,
  lastEpisodes: Number,
  lastStatus: String
});
const TrackedItem = mongoose.model('TrackedItem', TrackSchema);

const FavoriteSchema = new mongoose.Schema({
  userId: String,
  animeId: Number,
  animeTitle: String,
  lastEpisodes: Number
});
const FavoriteItem = mongoose.model('FavoriteItem', FavoriteSchema);

// Initialize Discord Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Helper Functions
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAniList(query, variables) {
  try {
    const response = await axios.post('https://graphql.anilist.co', { query, variables }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 10000
    });
    return response.data.data;
  } catch (err) {
    console.error('AniList API fetch error:', err);
    throw err;
  }
}

function getAiredEpisodes(anime) {
  if (anime.status === 'RELEASING' && anime.nextAiringEpisode?.episode) {
    return anime.nextAiringEpisode.episode - 1;
  }
  return anime.episodes || 0;
}

// Register Commands
const commands = [
  new SlashCommandBuilder().setName('start').setDescription('Welcome guide, basic features, and support contact'),
  new SlashCommandBuilder().setName('favorite').setDescription('Add an anime to your personal favorites')
    .addStringOption(opt => opt.setName('title').setDescription('Anime title to add').setRequired(true)),
  new SlashCommandBuilder().setName('unfavorite').setDescription('Remove an anime from your favorites')
    .addStringOption(opt => opt.setName('title').setDescription('Anime title to remove').setRequired(true)),
  new SlashCommandBuilder().setName('myfavorites').setDescription('List your favorite anime'),
  new SlashCommandBuilder().setName('help').setDescription('Show commands and usage'),
  new SlashCommandBuilder().setName('anime').setDescription('Search for an anime')
    .addStringOption(opt => opt.setName('title').setDescription('Anime title').setRequired(true)),
  new SlashCommandBuilder().setName('manga').setDescription('Search for a manga')
    .addStringOption(opt => opt.setName('title').setDescription('Manga title').setRequired(true)),
  new SlashCommandBuilder().setName('character').setDescription('Search for an anime character')
    .addStringOption(opt => opt.setName('name').setDescription('Character name').setRequired(true)),
  new SlashCommandBuilder().setName('genre').setDescription('Find anime by genre')
    .addStringOption(opt => opt.setName('category').setDescription('Choose genre').setRequired(true)
      .addChoices(
        { name: 'Action', value: 'Action' }, { name: 'Adventure', value: 'Adventure' },
        { name: 'Comedy', value: 'Comedy' }, { name: 'Fantasy', value: 'Fantasy' },
        { name: 'Romance', value: 'Romance' }, { name: 'Sci-Fi', value: 'Sci-Fi' },
        { name: 'Horror', value: 'Horror' }, { name: 'Sports', value: 'Sports' },
        { name: 'Slice of Life', value: 'Slice of Life' }
      )),
  new SlashCommandBuilder().setName('track').setDescription('Track anime in this channel')
    .addStringOption(opt => opt.setName('title').setDescription('Anime title').setRequired(true)),
  new SlashCommandBuilder().setName('untrack').setDescription('Stop tracking anime')
    .addStringOption(opt => opt.setName('title').setDescription('Anime title').setRequired(true)),
  new SlashCommandBuilder().setName('mytracked').setDescription('List tracked anime'),
  new SlashCommandBuilder().setName('testalert').setDescription('Run episode check (Dev only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('AniList for new episodes 📺', { type: ActivityType.Watching });
  client.user.setStatus('online');

  // Register Commands
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Commands registered.');
  } catch (err) {
    console.error('Error registering commands:', err);
  }

  // Start periodic updates
  setInterval(checkUpdates, 30 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  } else if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  }
});

// Button Interaction Handler
async function handleButtonInteraction(interaction) {
  if (interaction.customId.startsWith('track_btn_')) {
    await handleTrackButton(interaction);
  } else if (interaction.customId.startsWith('fav_btn_')) {
    await handleFavoriteButton(interaction);
  } else if (interaction.customId.startsWith('char_info_')) {
    await handleCharacterInfo(interaction);
  }
}

async function handleTrackButton(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const animeId = parseInt(interaction.customId.replace('track_btn_', ''));

  const gql = `
  query ($id: Int) {
    Media (id: $id, type: ANIME) {
      id
      title { romaji, english }
      episodes
      status
      siteUrl
    }
  }`;
  try {
    const data = await fetchAniList(gql, { id: animeId });
    const anime = data?.Media;
    if (!anime) return interaction.editReply('Anime not found!');

    const animeTitle = anime.title.english || anime.title.romaji || 'Unknown Anime';

    const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId });
    if (existing) {
      return interaction.editReply(`**${animeTitle}** is already tracked in this server!`);
    }

    await TrackedItem.create({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      animeId: anime.id,
      animeTitle: animeTitle,
      lastEpisodes: anime.episodes || 0,
      lastStatus: anime.status || 'UNKNOWN'
    });

    return interaction.editReply(`🎯 Successfully started tracking **[${animeTitle}](${anime.siteUrl})** in this channel!`);
  } catch (err) {
    console.error('Track button error:', err);
    return interaction.editReply('Failed to track anime.');
  }
}

async function handleFavoriteButton(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const animeId = parseInt(interaction.customId.replace('fav_btn_', ''));

  const gql = `
  query ($id: Int) {
    Media (id: $id, type: ANIME) {
      id
      title { romaji, english }
      episodes
      siteUrl
    }
  }`;
  try {
    const data = await fetchAniList(gql, { id: animeId });
    const anime = data?.Media;
    if (!anime) return interaction.editReply('Anime not found!');

    const animeTitle = anime.title.english || anime.title.romaji || 'Unknown Anime';

    const existing = await FavoriteItem.findOne({ userId: interaction.user.id, animeId });
    if (existing) {
      return interaction.editReply(`⭐ **${animeTitle}** is already in your favorites!`);
    }

    await FavoriteItem.create({
      userId: interaction.user.id,
      animeId: anime.id,
      animeTitle: animeTitle,
      lastEpisodes: anime.episodes || 0
    });

    return interaction.editReply(`⭐ Added **[${animeTitle}](${anime.siteUrl})** to your favorites!`);
  } catch (err) {
    console.error('Favorite button error:', err);
    return interaction.editReply('Failed to add favorite.');
  }
}

async function handleCharacterInfo(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const charId = parseInt(interaction.customId.replace('char_info_', ''));

  const gql = `
  query ($id: Int) {
    Character (id: $id) {
      id
      name { full, native, alternative }
      image { large }
      description(asHtml: false)
      siteUrl
      media (perPage: 5, sort: POPULARITY_DESC) {
        edges {
          node { title { english, romaji } }
        }
      }
    }
  }`;
  try {
    const data = await fetchAniList(gql, { id: charId });
    const char = data?.Character;
    if (!char) return interaction.editReply('Character not found!');

    const altNames = (char.name.alternative || []).filter(Boolean).join(', ') || 'N/A';
    const dob = char.dateOfBirth ? `${char.dateOfBirth.month ?? '?')}/${char.dateOfBirth.day ?? '?'}` : 'N/A';

    let desc = (char.description || '').replace(/~!/g, '||').replace(/!~/g, '||').replace(/<[^>]*>/gm, '');
    if (desc.length > 4000) desc = desc.substring(0, 4000) + '...';

    const appearsIn = char.media.edges
      ?.map(e => e.node?.title?.english || e.node?.title?.romaji)
      .filter(Boolean)
      .slice(0, 5)
      .join('\n') || 'N/A';

    const embed = new EmbedBuilder()
      .setTitle(`📖 ${char.name.full || 'Unknown'} — More Info`)
      .setURL(char.siteUrl || 'https://anilist.co')
      .setDescription(desc)
      .setThumbnail(char.image?.large || 'https://i.imgur.com/AGv4yDI.png')
      .addFields(
        { name: 'Native Name', value: char.name.native || 'N/A', inline: true },
        { name: 'Gender', value: char.gender || 'N/A', inline: true },
        { name: 'Age', value: char.age || 'N/A', inline: true },
        { name: 'Date of Birth', value: dob, inline: true },
        { name: 'Favorites', value: `${char.favourites || 0}`, inline: true },
        { name: 'Appears In', value: appearsIn, inline: false }
      )
      .setColor('#9b59b6');

    const infoBtn = new ButtonBuilder()
      .setCustomId(`char_info_${char.id}`)
      .setLabel('📖 More Info')
      .setStyle(ButtonStyle.Primary);

    const pinterestUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(char.name.full + ' anime fanart')}`;
    const fanartBtn = new ButtonBuilder()
      .setLabel('🎨 Fanart')
      .setStyle(ButtonStyle.Link)
      .setURL(pinterestUrl);

    const row = new ActionRowBuilder().addComponents(infoBtn, fanartBtn);
    return interaction.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Character info error:', err);
    return interaction.editReply('Failed to fetch character info.');
  }
}

// Main Command Handler
async function handleCommand(interaction) {
  const { commandName } = interaction;

  // Check for guildId where necessary
  const guildId = interaction.guildId || null;

  switch (commandName) {
    case 'start':
      await handleStartCommand(interaction);
      break;
    case 'character':
      await handleCharacterCommand(interaction);
      break;
    case 'favorite':
      await handleFavoriteCommand(interaction);
      break;
    case 'unfavorite':
      await handleUnfavoriteCommand(interaction);
      break;
    case 'myfavorites':
      await handleMyFavorites(interaction);
      break;
    case 'help':
      await handleHelp(interaction);
      break;
    case 'anime':
      await handleAnimeSearch(interaction);
      break;
    case 'manga':
      await handleMangaSearch(interaction);
      break;
    case 'genre':
      await handleGenre(interaction);
      break;
    case 'track':
      if (!guildId) {
        return interaction.reply({ content: '🎯 `/track` works inside a server channel!', ephemeral: true });
      }
      await handleTrackCommand(interaction);
      break;
    case 'untrack':
      if (!guildId) {
        return interaction.reply({ content: '🛑 `/untrack` works inside a server channel!', ephemeral: true });
      }
      await handleUntrackCommand(interaction);
      break;
    case 'mytracked':
      if (!guildId) {
        return interaction.reply({ content: 'No tracked anime in DMs.', ephemeral: true });
      }
      await handleMyTracked(interaction);
      break;
    case 'testalert':
      if (interaction.user.id !== process.env.DEV_USER_ID) {
        return interaction.reply({ content: '🚫 This command is for the developer only.', ephemeral: true });
      }
      await handleTestAlert(interaction);
      break;
    default:
      break;
  }
}

// Implement command functions similar to previous ones, e.g., handleStartCommand, handleCharacterCommand, etc.
// For brevity, only example for start command:

async function handleStartCommand(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('🚀 Welcome to AniTracker!')
    .setDescription('Your ultimate Discord companion for anime search, recommendations, and automatic episode notifications!')
    .addFields(
      { name: '✨ What can AniTracker do?', value: '• Search Anime & Manga details instantly.\n• Track anime in server channels for group alerts.\n• Add anime to personal favorites for **Direct Message (DM)** updates.\n• Find random high-rated anime by category/genre.' },
      { name: '📚 Quick Start Commands', value: '`/anime` - Search any anime\n`/genre` - Discover by genre\n`/track` - Track in channel\n`/favorite <title>` - Track in DMs\n`/help` - Show full commands list' },
      { name: '🐛 Report a Problem or Request Features', value: 'If you encounter bugs, issues, or suggestions, visit the support server.' }
    )
    .setColor('#2ecc71')
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: 'AniTracker • Developed for Anime Lovers' });

  const supportBtn = new ButtonBuilder()
    .setLabel('💬 Support Server')
    .setStyle(ButtonStyle.Link)
    .setURL('https://discord.gg/H4Af2y4RD8');

  const row = new ActionRowBuilder().addComponents(supportBtn);
  try {
    await interaction.user.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '📥 Check your DMs!', ephemeral: true });
  } catch {
    await interaction.reply({ content: '⚠️ Couldn\'t send DM. Please enable DMs.', ephemeral: true });
  }
}

// Similar functions should be implemented for other commands...

// Periodic update function
async function checkUpdates() {
  try {
    const trackedItems = await TrackedItem.find({});
    for (const item of trackedItems) {
      try {
        const gql = `
        query ($id: Int) {
          Media (id: $id, type: ANIME) {
            id
            title { english, romaji }
            episodes
            status
            coverImage { large }
            siteUrl
            nextAiringEpisode { episode }
          }
        }`;
        const data = await fetchAniList(gql, { id: item.animeId });
        const anime = data?.Media;
        if (anime) {
          const currentEps = getAiredEpisodes(anime);
          if (currentEps > item.lastEpisodes) {
            const channel = await client.channels.fetch(item.channelId).catch(() => null);
            if (channel) {
              const title = anime.title.english || anime.title.romaji || item.animeTitle;
              const embed = new EmbedBuilder()
                .setTitle('🚨 New Episode Alert!')
                .setDescription(`**[${title}](${anime.siteUrl})** has new episodes!\n\n📺 **Count:** ${currentEps}`)
                .setThumbnail(anime.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
                .setColor('#e74c3c')
                .setTimestamp();
              await channel.send({ embeds: [embed] });
            } else {
              await TrackedItem.deleteOne({ _id: item._id });
              continue;
            }
            // Update last episodes
            await TrackedItem.updateOne({ _id: item._id }, { lastEpisodes: currentEps, lastStatus: anime.status || 'UNKNOWN' });
          }
        }
      } catch (err) {
        console.error(`Error in tracking update:`, err);
      }
      await sleep(300);
    }

    // Check favorites for DM alerts
    const favorites = await FavoriteItem.find({});
    for (const fav of favorites) {
      try {
        const gql = `
        query ($id: Int) {
          Media (id: $id, type: ANIME) {
            id
            title { english, romaji }
            episodes
            status
            coverImage { large }
            siteUrl
            nextAiringEpisode { episode }
          }
        }`;
        const data = await fetchAniList(gql, { id: fav.animeId });
        const anime = data?.Media;
        if (anime) {
          const currentEps = getAiredEpisodes(anime);
          if (currentEps > fav.lastEpisodes) {
            const user = await client.users.fetch(fav.userId).catch(() => null);
            if (user) {
              const title = anime.title.english || anime.title.romaji || fav.animeTitle;
              const embed = new EmbedBuilder()
                .setTitle('⭐ Favorite Update!')
                .setDescription(`A new episode of **[${title}](${anime.siteUrl})** is out!\n\n📺 **Current Episodes:** ${currentEps}`)
                .setThumbnail(anime.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
                .setColor('#f1c40f')
                .setTimestamp();
              await user.send({ embeds: [embed] }).catch(() => null);
              // Update lastEpisodes
              await FavoriteItem.updateOne({ _id: fav._id }, { lastEpisodes: currentEps });
            }
          }
        }
      } catch (err) {
        console.error(`Error in DM update:`, err);
      }
      await sleep(300);
    }
  } catch (err) {
    console.error('Error in checkUpdates:', err);
  }
}

// Login
client.login(process.env.DISCORD_TOKEN);
