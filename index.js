const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ActivityType, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const http = require('http');
const mongoose = require('mongoose');
require('dotenv').config();
const { getAnimeJikan } = require('./jikanFallback');
// Web server workaround to keep Render alive 24/7
http.createServer((req, res) => {
    res.write("AniTracker is running!");
    res.end();
}).listen(process.env.PORT || 3000);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB Atlas!'))
    .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schema for Server Tracked Items
const TrackSchema = new mongoose.Schema({
    guildId: String,
    channelId: String,
    animeId: Number,
    animeTitle: String,
    lastEpisodes: Number,
    lastStatus: String
});
const TrackedItem = mongoose.model('TrackedItem', TrackSchema);

// MongoDB Schema for Personal Favorites (DM Alerts)
const FavoriteSchema = new mongoose.Schema({
    userId: String,
    animeId: Number,
    animeTitle: String,
    lastEpisodes: Number
});
const FavoriteItem = mongoose.model('FavoriteItem', FavoriteSchema);

// Manual age verification for the 18+ recommendation categories.
const AgeVerificationSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    verifiedAt: { type: Date, default: Date.now }
});
const AgeVerification = mongoose.model('AgeVerification', AgeVerificationSchema);

// 1. تعريف مصفوفة التصنيفات
const GENRE_OPTIONS = [
    { value: 'Action', label: 'Action', description: 'High-stakes battles and heroic conflicts', filterType: 'genre', apiValue: 'Action' },
    { value: 'Adventure', label: 'Adventure', description: 'Journeys, quests, and exploration', filterType: 'genre', apiValue: 'Adventure' },
    { value: 'Comedy', label: 'Comedy', description: 'Humor, jokes, and funny situations', filterType: 'genre', apiValue: 'Comedy' },
    { value: 'Drama', label: 'Drama', description: 'Emotional conflict and serious stories', filterType: 'genre', apiValue: 'Drama' },
    { value: 'Fantasy', label: 'Fantasy', description: 'Magic, myths, and imaginary worlds', filterType: 'genre', apiValue: 'Fantasy' },
    { value: 'Romance', label: 'Romance', description: 'Love stories and relationships', filterType: 'genre', apiValue: 'Romance' },
    { value: 'Sci-Fi', label: 'Sci-Fi', description: 'Technology, space, and future worlds', filterType: 'genre', apiValue: 'Sci-Fi' },
    { value: 'Horror', label: 'Horror', description: 'Fear, suspense, and dark themes', filterType: 'genre', apiValue: 'Horror' },
    { value: 'Sports', label: 'Sports', description: 'Competition, training, and teamwork', filterType: 'genre', apiValue: 'Sports' },
    { value: 'Slice of Life', label: 'Slice of Life', description: 'Everyday life and relatable moments', filterType: 'genre', apiValue: 'Slice Of Life' },
    { value: 'Shonen', label: 'Shonen', description: 'Action-focused stories for young audiences', filterType: 'tag', apiValue: 'Shounen' },
    { value: 'Shojo', label: 'Shojo', description: 'Romance-focused stories for young audiences', filterType: 'tag', apiValue: 'Shoujo' },
    { value: 'Isekai', label: 'Isekai', description: 'Characters transported to another world', filterType: 'tag', apiValue: 'Isekai' },
    { value: 'Ecchi', label: 'Ecchi 🔞', description: '18+ mature fan-service themes', filterType: 'genre', apiValue: 'Ecchi', adultOnly: true },
    { value: 'Hentai', label: 'Hentai 🔞', description: '18+ explicit adult themes', filterType: 'genre', apiValue: 'Hentai', adultOnly: true }
];

// 2. دالة تصفية التصنيفات بناءً على توثيق العمر (خارج المصفوفة)
async function getAvailableGenres(userId) {
    const isVerified = await AgeVerification.findOne({ userId });
    
    // لو موثق يرجع كل التصنيفات، لو مش موثق يستبعد خيارات adultOnly
    return GENRE_OPTIONS.filter(option => isVerified || !option.adultOnly);
}

// 3. دالة البحث عن تعريف التصنيف
function getGenreDefinition(value) {
    return GENRE_OPTIONS.find(option => option.value === value);
}
function buildMediaTypeMenu() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('genre_media_select')
        .setPlaceholder('Choose Anime or Manga')
        .addOptions(
            {
                label: 'Anime',
                value: 'anime',
                description: 'Get an anime recommendation by category'
            },
            {
                label: 'Manga',
                value: 'manga',
                description: 'Get a manga recommendation by category'
            }
        );

    return new ActionRowBuilder().addComponents(menu);
}

function buildGenreMenu(mediaType) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`genre_select_${mediaType}`)
        .setPlaceholder(`Choose a ${mediaType} category`)
        .addOptions(GENRE_OPTIONS.map(option => ({
            label: option.label,
            value: option.value,
            description: option.description
        })));

    return new ActionRowBuilder().addComponents(menu);
}

// FIX: removed GatewayIntentBits.GuildPresences — it's a privileged intent that
// requires manual approval/toggling in the Discord Developer Portal, and nothing
// in this bot actually listens to presence events. Guilds is enough for slash commands.
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

// Small delay helper — used to avoid bursting AniList's rate limit (≈90 req/min)
// when looping over many tracked/favorite items in checkUpdates().
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper لمنع تجاوز حد طلبات AniList
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// دالة جلب البيانات عبر Vercel Proxy
async function fetchAniList(query, variables) {
    try {
        const response = await axios.post('https://anilist-proxy-lemon.vercel.app/api/proxy', {
            query,
            variables
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        if (response.data && response.data.data) {
            return response.data.data;
        }
        return null;
    } catch (error) {
        console.error('Proxy Fetch Error:', error.response ? error.response.status : error.message);
        return null;
    }
}

// Helper لمعرفة عدد الحلقات المعروضة بالفعل
function getAiredEpisodes(anime) {
    if (anime.status === 'RELEASING' && anime.nextAiringEpisode?.episode) {
        return anime.nextAiringEpisode.episode - 1;
    }
    return anime.episodes || 0;
}

module.exports = {
    fetchAniList,
    sleep,
    getAiredEpisodes
};
// Register Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Welcome guide, basic features, and support contact'),
    new SlashCommandBuilder()
        .setName('favorite')
        .setDescription('Add an anime to your personal favorites (Receive DM notifications)')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title to add to favorites')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('unfavorite')
        .setDescription('Remove an anime from your personal favorites')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title to remove from favorites')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('myfavorites')
        .setDescription('List all your personal favorite anime'),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Displays a list of available commands and bot usage guide'),
    new SlashCommandBuilder()
        .setName('anime')
        .setDescription('Search for an anime')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('manga')
        .setDescription('Search for a manga')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Manga title')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('character')
        .setDescription('Search for an anime character')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Character name')
                .setRequired(true)),
    new SlashCommandBuilder()
    .setName('genre')
    .setDescription('Choose Anime or Manga, then get a recommendation by category')
    .addStringOption(option =>
        option.setName('status')
            .setDescription('Filter by status (Optional)')
            .setRequired(false)
            .addChoices(
                { name: 'Ongoing', value: 'RELEASING' },
                { name: 'Finished', value: 'FINISHED' }
            )),
    new SlashCommandBuilder()
    .setName('servers')
    .setDescription('(Owner only) List all servers the bot is currently in')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
    .setName('broadcast')
    .setDescription('(Owner only) Broadcast an announcement message to all servers')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
        option.setName('message')
            .setDescription('The announcement message to send')
            .setRequired(true)
    ),
    new SlashCommandBuilder()
        .setName('track')
        .setDescription('Track an anime for new episode updates in this channel')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title to track')
                .setRequired(true)),
    new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('📅 Displays today\'s anime release schedule!'),
    new SlashCommandBuilder()
        .setName('untrack')
        .setDescription('Stop tracking an anime in this channel')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title to untrack')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('mytracked')
        .setDescription('List all tracked anime in this server'),
    // NEW: dev-only command to manually trigger the 30-min episode check on demand,
    // so new-episode alerts can be tested without waiting for the real interval.
    // FIX: hidden from regular members by default — only users with Administrator
    // permission in a server will even see this command in the slash command list.
    // The actual DEV_USER_ID check in the handler still gates who can run it.
    new SlashCommandBuilder()
        .setName('testalert')
        .setDescription('(Dev only) Manually run the episode-alert check right now')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('unverifyage')
        .setDescription('(Owner only) Remove 18+ age verification for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to unverify')
                .setRequired(true)),
     new SlashCommandBuilder()
        .setName('maintenance-dm')
        .setDescription('(Dev only) send a dm msg to all servers and users')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    .addStringOption(option =>
        option.setName('message')
            .setDescription('Type the message you want to send')
            .setRequired(true)
    ),
    new SlashCommandBuilder()
    .setName('getinvite')
    .setDescription('(Dev only) Generate an invite link for a server')
    .addStringOption(option =>
        option.setName('guild_id')
            .setDescription('The ID of the server')
            .setRequired(true)
    )
    new SlashCommandBuilder()
        .setName('eval')
        .setDescription('(Owner only) Evaluate JavaScript code')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => 
            option.setName('code')
                .setDescription('The JavaScript code to execute')
                .setRequired(true)
        ),
        new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('(Dev only) Change the bot status or activity')
    .addStringOption(option =>
        option.setName('activity')
            .setDescription('The activity text (e.g., Watching servers)')
            .setRequired(true)
    )
    .addStringOption(option =>
        option.setName('type')
            .setDescription('Activity type')
            .setRequired(true)
            .addChoices(
                { name: 'Playing', value: '0' },
                { name: 'Streaming', value: '1' },
                { name: 'Listening', value: '2' },
                { name: 'Watching', value: '3' },
                { name: 'Competing', value: '5' }
            )
    )
    new SlashCommandBuilder()
        .setName('verifyage')
        .setDescription('(Owner only) Approve a user for 18+ genre recommendations')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User who completed age verification in DMs')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    client.user.setActivity('AniList for new episodes 📺', { type: ActivityType.Watching });
    client.user.setStatus('online');

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('Successfully reloaded application (/) commands!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
async function checkUpdates() {
    console.log('Checking for updates...');
}
    // Background Tracker Loop (Checks every 30 minutes)
    setInterval(checkUpdates, 30 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
   // 🎲 Genre recommendation menus & 🔘 Handle Interactive Buttons
if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'genre_media_select') {
        const mediaType = interaction.values[0];
        return interaction.update({
            content: `📚 You chose **${mediaType === 'anime' ? 'Anime' : 'Manga'}**. Now choose a category:`,
            components: [buildGenreMenu(mediaType)]
        });
    }

    if (interaction.customId.startsWith('genre_select_')) {
        const mediaType = interaction.customId.replace('genre_select_', '');
        const genreChoice = interaction.values[0];
        const genreDefinition = getGenreDefinition(genreChoice);

        if (!genreDefinition) {
            return interaction.update({
                content: '❌ That category is no longer available. Please run `/genre` again.',
                components: []
            });
        }

        if (genreDefinition.adultOnly) {
            let isVerified = false;
            try {
                isVerified = Boolean(await AgeVerification.exists({ userId: interaction.user.id }));
            } catch (err) {
                console.error('age verification lookup error:', err);
                return interaction.update({
                    content: '❌ I could not check your age verification right now. Please try again later.',
                    components: []
                });
            }

            if (!isVerified) {
                return interaction.update({
                    content: `🔞 **This category is restricted to verified adults.**\n\n👤 **Owner:** \`_h8rtless_\`\n💬 Join our support server to open a ticket and verify your age:\nhttps://discord.gg/H4Af2y4RD8`,
                    components: []
                });
            }

            if (interaction.guildId) {
                return interaction.update({
                    content: '🔞 18+ recommendations are available in DMs only. Please run `/genre` in a DM after your age has been verified.',
                    components: []
                });
            }
        }

        await interaction.deferUpdate();

        const gqlQuery = `
        query ($type: MediaType, $genre: String, $tag: String, $status: MediaStatus) {
          Page (page: 1, perPage: 10) {
            media (type: $type, genre: $genre, tag: $tag, status: $status, sort: SCORE_DESC) {
              id
              title { romaji english }
              episodes
              chapters
              status
              averageScore
              description(asHtml: false)
              coverImage { large }
              siteUrl
            }
          }
        }`;

        let mediaList = null;

        // 1. Try AniList First
        try {
            const data = await fetchAniList(gqlQuery, {
                type: mediaType === 'manga' ? 'MANGA' : 'ANIME',
                genre: genreDefinition.filterType === 'genre' ? genreDefinition.apiValue : null,
                tag: genreDefinition.filterType === 'tag' ? genreDefinition.apiValue : null,
                status: genreChoice === 'ongoing' ? 'RELEASING' : null
            });
            mediaList = data?.Page?.media;
        } catch (err) {
            console.error('Genre AniList Fetch Error:', err.message);
        }

        // 2. Fallback (If AniList failed or returned no data)
        if (!mediaList || mediaList.length === 0) {
            console.log(`AniList failed for genre [${genreDefinition.label}]. Attempting Fallback...`);
            try {
                const isOngoing = genreChoice === 'ongoing';
                const jikanData = await getAnimeJikan(genreDefinition.label, isOngoing);

                if (jikanData) {
                    const fallbackEmbed = new EmbedBuilder()
                        .setTitle(`🎭 ${genreDefinition.label} ${mediaType === 'anime' ? 'Anime' : 'Manga'} Recommendation: ${jikanData.title}`)
                        .setURL(jikanData.url || 'https://kitsu.io')
                        .setThumbnail(jikanData.image || 'https://i.imgur.com/AGv4yDI.png')
                        .addFields(
                            {
                                name: mediaType === 'anime' ? 'Episodes' : 'Chapters',
                                value: `${mediaType === 'anime' ? (jikanData.episodes ?? 'N/A') : (jikanData.chapters ?? 'N/A')}`,
                                inline: true
                            },
                            { name: 'Status', value: jikanData.status || 'N/A', inline: true },
                            { name: 'Score', value: jikanData.score || 'N/A', inline: true }
                        )
                        .setDescription(jikanData.synopsis)
                        .setColor(genreDefinition.adultOnly ? '#8e44ad' : '#1abc9c');

                    await interaction.editReply({ content: '', embeds: [fallbackEmbed], components: [] });

                    const DEV_ID = '1326815636395003966';
                    if (interaction.user.id === DEV_ID) {
                        await interaction.followUp({
                            content: '🚨 **[Dev Alert]:** AniList genre lookup was unreachable. Recommendation fetched via Emergency Backup!',
                            ephemeral: true
                        });
                    }

                    return;
                }
            } catch (fallbackErr) {
                console.error('Genre Fallback Error:', fallbackErr);
            }

            return await interaction.editReply({
                content: `❌ No ${mediaType} found for **${genreDefinition.label}** on AniList or Emergency Backup.`,
                components: []
            });
        }

        // 3. Render AniList Data
        try {
            const media = mediaList[Math.floor(Math.random() * mediaList.length)];
            const title = (media.title && (media.title.english || media.title.romaji)) || `${mediaType} title`;
            const cleanDesc = media.description
                ? media.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...'
                : 'No synopsis available.';

            const embed = new EmbedBuilder()
                .setTitle(`🎭 ${genreDefinition.label} ${mediaType === 'anime' ? 'Anime' : 'Manga'} Recommendation: ${title}`)
                .setURL(media.siteUrl || 'https://anilist.co')
                .setThumbnail(media.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
                .addFields(
                    {
                        name: mediaType === 'anime' ? 'Episodes' : 'Chapters',
                        value: `${mediaType === 'anime' ? (media.episodes ?? 'N/A') : (media.chapters ?? 'N/A')}`,
                        inline: true
                    },
                    { name: 'Status', value: media.status || 'N/A', inline: true },
                    { name: 'Score', value: media.averageScore ? `${media.averageScore} / 100` : 'N/A', inline: true }
                )
                .setDescription(cleanDesc)
                .setColor(genreDefinition.adultOnly ? '#8e44ad' : '#1abc9c');

            const components = [];
            if (mediaType === 'anime') {
                const trackBtn = new ButtonBuilder()
                    .setCustomId(`track_btn_${media.id}`)
                    .setLabel('🎯 Channel Track')
                    .setStyle(ButtonStyle.Success);

                const favBtn = new ButtonBuilder()
                    .setCustomId(`fav_btn_${media.id}`)
                    .setLabel('⭐ Favorite (DM Alert)')
                    .setStyle(ButtonStyle.Primary);

                const buttons = [favBtn];
                if (interaction.guildId && media.status !== 'FINISHED') {
                    buttons.unshift(trackBtn);
                }
                components.push(new ActionRowBuilder().addComponents(...buttons));
            }

            await interaction.editReply({ content: '', embeds: [embed], components });
        } catch (err) {
            console.error('genre recommendation error:', err);
            await interaction.editReply({
                content: '❌ Failed to fetch this recommendation. Please try `/genre` again.',
                components: []
            });
        }
    }
    return;
}

if (interaction.isButton()) {
    if (interaction.customId.startsWith('track_btn_')) {
        if (!interaction.guildId) {
            return interaction.reply({
                content: '🎯 Channel tracking works inside a server. Use `/favorite <title>` for personal DM alerts.',
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });
        const animeId = parseInt(interaction.customId.replace('track_btn_', ''));

        const gqlQuery = `
        query ($id: Int) {
          Media (id: $id, type: ANIME) {
            id
            title { romaji english }
            episodes
            status
            siteUrl
          }
        }`;

        let anime = null;
        try {
            const data = await fetchAniList(gqlQuery, { id: animeId });
            anime = data?.Media;
        } catch (err) {
            console.error('Track Button AniList Error:', err.message);
        }

        if (!anime) {
            const DEV_ID = '1326815636395003966';
            if (interaction.user.id === DEV_ID) {
                await interaction.followUp({
                    content: '🚨 **[Dev Alert]:** AniList unreachable during track operation.',
                    ephemeral: true
                });
            }
            return await interaction.editReply({ content: '❌ Could not connect to primary services to track this anime. Please try again in a moment.' });
        }

        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || 'Unknown Anime';
        const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: anime.id });

        if (existing) {
            return await interaction.editReply({ content: `**${animeTitle}** is already tracked in this server!` });
        }

        await TrackedItem.create({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            animeId: anime.id,
            animeTitle: animeTitle,
            lastEpisodes: anime.episodes || 0,
            lastStatus: anime.status || 'UNKNOWN'
        });

        await interaction.editReply({ content: `🎯 Successfully started tracking **[${animeTitle}](${anime.siteUrl})** in this channel!` });
    }
    else if (interaction.customId.startsWith('fav_btn_')) {
        await interaction.deferReply({ ephemeral: true });
        const animeId = parseInt(interaction.customId.replace('fav_btn_', ''));

        const gqlQuery = `
        query ($id: Int) {
          Media (id: $id, type: ANIME) {
            id
            title { romaji english }
            episodes
            siteUrl
          }
        }`;

        let anime = null;
        try {
            const data = await fetchAniList(gqlQuery, { id: animeId });
            anime = data?.Media;
        } catch (err) {
            console.error('Fav Button AniList Error:', err.message);
        }

        if (!anime) {
            const DEV_ID = '1326815636395003966';
            if (interaction.user.id === DEV_ID) {
                await interaction.followUp({
                    content: '🚨 **[Dev Alert]:** AniList unreachable during favorite operation.',
                    ephemeral: true
                });
            }
            return await interaction.editReply({ content: '❌ Could not connect to primary services to save favorite. Please try again in a moment.' });
        }

        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || 'Unknown Anime';
        const existing = await FavoriteItem.findOne({ userId: interaction.user.id, animeId: anime.id });

        if (existing) {
            return await interaction.editReply({ content: `⭐ **${animeTitle}** is already in your personal favorites!` });
        }

        await FavoriteItem.create({
            userId: interaction.user.id,
            animeId: anime.id,
            animeTitle: animeTitle,
            lastEpisodes: anime.episodes || 0
        });

        await interaction.editReply({ content: `⭐ Added **[${animeTitle}](${anime.siteUrl})** to your personal favorites! You will receive direct messages (DMs) when new episodes arrive.` });
    }
    else if (interaction.customId.startsWith('char_info_')) {
        await interaction.deferReply({ ephemeral: true });
        const charId = parseInt(interaction.customId.replace('char_info_', ''));

        const gqlQuery = `
        query ($id: Int) {
          Character (id: $id) {
            id
            name { full native alternative }
            image { large }
            description(asHtml: false)
            gender
            age
            dateOfBirth { year month day }
            favourites
            siteUrl
            media (perPage: 5, sort: POPULARITY_DESC) {
              edges {
                voiceActors (language: JAPANESE) {
                  name { full }
                }
                node {
                  title { romaji english }
                }
              }
            }
          }
        }`;

        let char = null;
        try {
            const data = await fetchAniList(gqlQuery, { id: charId });
            char = data?.Character;
        } catch (err) {
            console.error('Character Info AniList Error:', err.message);
        }

        if (!char) {
            const DEV_ID = '1326815636395003966';
            if (interaction.user.id === DEV_ID) {
                await interaction.followUp({
                    content: '🚨 **[Dev Alert]:** AniList unreachable during character info fetch.',
                    ephemeral: true
                });
            }
            return await interaction.editReply({ content: '❌ Character information is currently unavailable from primary services.' });
        }

        const altNames = char.name?.alternative?.filter(Boolean).join(', ') || 'N/A';
        const dob = (char.dateOfBirth && (char.dateOfBirth.month || char.dateOfBirth.day))
            ? `${char.dateOfBirth.month ?? '?'}/${char.dateOfBirth.day ?? '?'}`
            : 'N/A';

        let cleanDesc = char.description ? char.description
            .replace(/~!/g, '||')
            .replace(/!~/g, '||')
            .replace(/<[^>]*>/gm, '') : 'No description available.';
        if (cleanDesc.length > 4000) cleanDesc = cleanDesc.substring(0, 4000) + '...';

        const appearsIn = char.media?.edges
            ?.map(e => e.node?.title?.english || e.node?.title?.romaji)
            .filter(Boolean)
            .slice(0, 5)
            .join('\n') || 'N/A';

        const voiceActorJP = char.media?.edges?.find(e => e.voiceActors?.[0]?.name?.full)?.voiceActors?.[0]?.name?.full || 'N/A';

        const embed = new EmbedBuilder()
            .setTitle(`📖 ${char.name?.full || 'Unknown'} — More Info`)
            .setURL(char.siteUrl || 'https://anilist.co')
            .setDescription(cleanDesc)
            .setThumbnail(char.image?.large || 'https://i.imgur.com/AGv4yDI.png')
            .addFields(
                { name: 'Native Name', value: char.name?.native || 'N/A', inline: true },
                { name: 'Gender', value: char.gender || 'N/A', inline: true },
                { name: 'Age', value: char.age || 'N/A', inline: true },
                { name: 'Date of Birth', value: dob, inline: true },
                { name: 'Favorites', value: `${char.favourites ? char.favourites.toLocaleString() : 0}`, inline: true },
                { name: 'Voice Actor (JP)', value: voiceActorJP, inline: true },
                { name: 'Appears In', value: appearsIn, inline: false },
                { name: 'Alternative Names', value: altNames, inline: false }
            )
            .setColor('#9b59b6');

        await interaction.editReply({ embeds: [embed] });
    }
    return;
    }
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // 🚀 Start Command
    if (commandName === 'start') {
        const embed = new EmbedBuilder()
            .setTitle('🚀 Welcome to AniTracker!')
            .setDescription('Your ultimate Discord companion for anime search, recommendations, and automatic episode notifications!')
            .addFields(
                { name: '✨ What can AniTracker do?', value: '• Search Anime & Manga details instantly.\n• Track anime in server channels for group alerts.\n• Add anime to personal favorites for **Direct Message (DM)** updates.\n• Find random high-rated anime by category/genre.' },
                { name: '📚 Quick Start Commands', value: '`/anime` - Search any anime\n`/manga` - Search any manga\n`/genre` - Choose Anime/Manga, then a category\n`/track` - Track anime in a server channel\n`/favorite <title>` - Receive personal DM updates\n`/help` - Show full commands list' },
                { name: '🐛 Report a Problem or Request Features', value: 'If you encounter any bugs, issues, or have suggestions, please visit the support server for more help.' }
            )
            .setColor('#2ecc71')
            .setThumbnail(client.user.displayAvatarURL())
            .setFooter({ text: 'AniTracker • Developed for Anime Lovers' });

        const supportBtn = new ButtonBuilder()
            .setLabel('💬 Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.gg/H4Af2y4RD8');

        const row = new ActionRowBuilder().addComponents(supportBtn);

        if (!interaction.guildId) {
            return interaction.reply({ embeds: [embed], components: [row] });
        }

        try {
            await interaction.user.send({ embeds: [embed], components: [row] });
            await interaction.reply({
                content: '📥 Check your Direct Messages! I sent you the getting started guide.',
                ephemeral: true
            });
        } catch (error) {
            await interaction.reply({
                content: '⚠️ Couldn\'t send you a DM! Please open your Direct Messages in privacy settings.',
                embeds: [embed],
                components: [row],
                ephemeral: true
            });
        }
    }

   // 🔞 Owner-controlled age verification (Approve)
else if (commandName === 'verifyage') {
    const DEV_ID = process.env.DEV_USER_ID || '1326815636395003966';

    // 1. Owner Check Guard
    if (interaction.user.id !== DEV_ID) {
        return interaction.reply({ 
            content: `🚫 Only the bot owner can approve age verification, owner username: \`_h8rtless_\`.\n\n💬 Join our support server to open a ticket and verify your age:\nhttps://discord.gg/H4Af2y4RD8`, 
            flags: 64 
        });
    }

    const user = interaction.options.getUser('user');
    if (!user) {
        return interaction.reply({ content: '❌ Please select a valid user to verify.', flags: 64 });
    }

    // Defer reply to handle potential network delay with DB and DMs
    await interaction.deferReply({ flags: 64 });

    try {
        // 2. Update DB with upsert
        await AgeVerification.updateOne(
            { userId: user.id },
            { $set: { userId: user.id, verifiedAt: new Date() } },
            { upsert: true }
        );

        // 3. DM Notification
        let dmSent = true;
        try {
            await user.send(`🎉 **Age Verification Approved!**\nYour account has been verified by the owner. You can now request and view 18+ adult genre recommendations linked to AniList.`);
        } catch (dmErr) {
            dmSent = false;
        }

        // 4. Response back to Owner
        const dmStatusText = dmSent ? '📬 DM notification sent.' : '⚠️ Could not send DM (User DMs are disabled).';
        
        await interaction.editReply({
            content: `✅ **${user.tag}** is now approved for 18+ AniList genre recommendations.\n${dmStatusText}`
        });

    } catch (err) {
        console.error('verifyage command error:', err);
        await interaction.editReply({ 
            content: '❌ Could not save the age verification in database. Please check console logs.' 
        });
    }
}
        
    // 🚫 Owner-controlled age unverification (Remove)
else if (commandName === 'unverifyage') {
    const DEV_ID = process.env.DEV_USER_ID || '1326815636395003966';

    // 1. Owner Check Guard
    if (interaction.user.id !== DEV_ID) {
        return interaction.reply({ 
            content: '🚫 Only the bot owner can remove age verification.', 
            flags: 64 
        });
    }

    const user = interaction.options.getUser('user');
    if (!user) {
        return interaction.reply({ content: '❌ Please select a valid user.', flags: 64 });
    }

    // Defer reply immediately to handle database & DM delay
    await interaction.deferReply({ flags: 64 });

    try {
        // 2. Check if user is actually verified
        const existingVerification = await AgeVerification.findOne({ userId: user.id });

        if (!existingVerification) {
            return await interaction.editReply({
                content: `⚠️ **${user.tag}** is not currently age-verified.`
            });
        }

        // 3. Delete from DB
        await AgeVerification.deleteOne({ userId: user.id });

        // 4. DM Notification
        let dmSent = true;
        try {
            await user.send(`🔒 **Age Verification Removed.**\nYour 18+ access status for AniList content has been revoked by the bot owner.`);
        } catch (dmErr) {
            dmSent = false;
        }

        // 5. Response back to Owner
        const dmStatusText = dmSent ? '📬 DM notification sent.' : '⚠️ Could not send DM (User DMs are disabled).';
        
        await interaction.editReply({
            content: `🗑️ Age verification removed for **${user.tag}**. 18+ AniList recommendations are now locked for this user.\n${dmStatusText}`
        });

    } catch (err) {
        console.error('unverifyage command error:', err);
        await interaction.editReply({ 
            content: '❌ Could not remove age verification. Please try again later.' 
        });
    }
}
   // 📅 Today's Anime Schedule Command (With Kitsu Fallback)
else if (commandName === 'schedule') {
    await interaction.deferReply();

    try {
        const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        const endOfDay = Math.floor(new Date().setHours(23, 59, 59, 999) / 1000);

        const gqlQuery = `
        query ($start: Int, $end: Int) {
          Page(perPage: 25) {
            airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
              episode
              airingAt
              media {
                title { english romaji }
              }
            }
          }
        }`;

        let schedules = [];

        // 1. Primary Attempt: AniList API
        try {
            const data = await fetchAniList(gqlQuery, { start: startOfDay, end: endOfDay });
            schedules = data?.Page?.airingSchedules || [];
        } catch (aniListErr) {
            console.warn('AniList failed for schedule, switching to Kitsu Fallback:', aniListErr.message);
        }

        // 2. Secondary Fallback: Kitsu API
        if (schedules.length === 0) {
            const kitsuRes = await fetch('https://kitsu.io/api/edge/anime?filter[status]=current&page[limit]=10&sort=-userCount')
                .then(res => res.json())
                .catch(() => null);

            if (kitsuRes?.data) {
                schedules = kitsuRes.data.map(item => ({
                    episode: item.attributes.episodeCount || 'N/A',
                    airingAt: Math.floor(Date.now() / 1000), // Approximate timestamp
                    media: {
                        title: {
                            english: item.attributes.titles.en || item.attributes.canonicalTitle,
                            romaji: item.attributes.canonicalTitle
                        }
                    }
                }));
            }
        }

        if (schedules.length === 0) {
            return await interaction.editReply('📅 No new anime episodes scheduled for today!');
        }

        const listContent = schedules.map(item => {
            const title = (item.media?.title?.english || item.media?.title?.romaji || 'Unknown Anime');
            const timeString = `<t:${item.airingAt}:t>`;
            return `• **Ep ${item.episode}** - **${title}** at ${timeString}`;
        }).join('\n');

        const safeDescription = listContent.length > 3900 
            ? listContent.substring(0, 3900) + '\n\n*...and more episodes.*' 
            : listContent;

        const embed = new EmbedBuilder()
            .setColor('#ff69b4')
            .setTitle('📅 Today\'s Anime Schedule')
            .setDescription(safeDescription)
            .setFooter({ text: `Total scheduled today: ${schedules.length}` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (err) {
        console.error('Error fetching schedule:', err);
        await interaction.editReply('❌ An error occurred while fetching today\'s schedule. Please try again later!');
    }
}
        // 🎭 Character Search Command (Updated with Emergency Backup)
else if (commandName === 'character') {
    const characterName = interaction.options.getString('name');
    await interaction.deferReply();

    const gqlQuery = `
    query ($search: String) {
      Character (search: $search) {
        id
        name { full native alternative }
        image { large }
        description(asHtml: false)
        siteUrl
        favourites
        gender
        age
        dateOfBirth { year month day }
        media (perPage: 25, sort: POPULARITY_DESC) {
          edges {
            voiceActors (language: JAPANESE) {
              id
              name { full native }
              siteUrl
            }
            node {
              id
              title { romaji english }
              season
              seasonYear
              type
            }
          }
        }
      }
    }`;

    let char = null;

    // 1. Try AniList First
    try {
        const data = await fetchAniList(gqlQuery, { search: characterName });
        char = data?.Character;
    } catch (err) {
        console.error('Character AniList Fetch Error:', err.message);
    }

    // 2. Emergency Backup (Jikan API) if AniList is down or returned no character
    if (!char) {
        console.log(`AniList failed or returned no character for [${characterName}]. Attempting Backup...`);
        try {
            const jikanRes = await fetch(`https://api.jikan.moe/v4/characters?q=${encodeURIComponent(characterName)}&limit=1`);
            const jikanData = await jikanRes.json();
            const jikanChar = jikanData?.data?.[0];

            if (jikanChar) {
                let cleanDesc = jikanChar.about
                    ? jikanChar.about.replace(/~!/g, '||').replace(/!~/g, '||').replace(/<[^>]*>/gm, '')
                    : 'No description available.';
                if (cleanDesc.length > 350) cleanDesc = cleanDesc.substring(0, 350) + '...';

                const nameFull = jikanChar.name || characterName;
                const nameKanji = jikanChar.name_kanji ? ` (${jikanChar.name_kanji})` : '';

                const embed = new EmbedBuilder()
                    .setTitle(`🎭 ${nameFull}${nameKanji}`)
                    .setURL(jikanChar.url || 'https://myanimelist.net')
                    .setDescription(cleanDesc)
                    .addFields(
                        { name: '❤️ Favorites', value: `${jikanChar.favorites ? jikanChar.favorites.toLocaleString() : 0}`, inline: true }
                    )
                    .setImage(jikanChar.images?.jpg?.image_url || 'https://i.imgur.com/AGv4yDI.png')
                    .setColor('#9b59b6')
                    .setFooter({ text: 'AniTracker • Character Search (Backup API)' });

                const pinterestLink = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(nameFull + ' anime fanart')}`;
                const animeFanartBtn = new ButtonBuilder()
                    .setLabel('🎨 Fanart')
                    .setStyle(ButtonStyle.Link)
                    .setURL(pinterestLink);

                const row = new ActionRowBuilder().addComponents(animeFanartBtn);

                await interaction.editReply({ embeds: [embed], components: [row] });

                // Dev Alert
                const DEV_ID = '1326815636395003966';
                if (interaction.user.id === DEV_ID) {
                    await interaction.followUp({
                        content: '🚨 **[Dev Alert]:** AniList character lookup was unreachable or empty. Fetched via Emergency Backup (Jikan)!',
                        ephemeral: true
                    });
                }

                return;
            }
        } catch (backupErr) {
            console.error('Character Backup Fetch Error:', backupErr);
        }

        return await interaction.editReply(`❌ Sorry, no character found with the name **"${characterName}"** on AniList or Emergency Backup.`);
    }

    // 3. Render AniList Data
    try {
        const nameFull = char.name?.full || characterName;
        const nameNative = char.name?.native ? ` (${char.name.native})` : '';
        const animeSource = char.media?.edges?.[0]?.node?.title?.english
            || char.media?.edges?.[0]?.node?.title?.romaji
            || 'Unknown Anime';

        let cleanDesc = char.description ? char.description
            .replace(/~!/g, '||')
            .replace(/!~/g, '||')
            .replace(/<[^>]*>/gm, '') : 'No description available.';
        if (cleanDesc.length > 350) cleanDesc = cleanDesc.substring(0, 350) + '...';

        const embed = new EmbedBuilder()
            .setTitle(`🎭 ${nameFull}${nameNative}`)
            .setURL(char.siteUrl || 'https://anilist.co')
            .setDescription(cleanDesc)
            .addFields(
                { name: '📺 From Anime', value: animeSource, inline: true },
                { name: '❤️ Favorites', value: `${char.favourites ? char.favourites.toLocaleString() : 0}`, inline: true }
            )
            .setImage(char.image?.large || 'https://i.imgur.com/AGv4yDI.png')
            .setColor('#9b59b6')
            .setFooter({ text: 'AniTracker • Character Search' });

        const infoBtn = new ButtonBuilder()
            .setCustomId(`char_info_${char.id}`)
            .setLabel('📖 More Info')
            .setStyle(ButtonStyle.Primary);

        const pinterestLink = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(nameFull + ' anime fanart')}`;
        const animeFanartBtn = new ButtonBuilder()
            .setLabel('🎨 Fanart')
            .setStyle(ButtonStyle.Link)
            .setURL(pinterestLink);

        const row = new ActionRowBuilder().addComponents(infoBtn, animeFanartBtn);

        await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (err) {
        console.error('Character command error:', err);
        await interaction.editReply('Failed to fetch character data.');
    }
}
   // ⭐ Favorite Command (With Emergency Fallback & Dev Alert)
else if (commandName === 'favorite') {
    await interaction.deferReply({ ephemeral: true });
    const searchQuery = interaction.options.getString('title');

    const gqlQuery = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title { romaji english }
        episodes
        siteUrl
      }
    }`;

    let anime = null;

    // 1. Try AniList First
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        anime = data?.Media;
    } catch (err) {
        console.error('Favorite AniList Fetch Error:', err.message);
    }

    // 2. Emergency Backup (Kitsu API) if AniList is down
    if (!anime) {
        console.log(`AniList failed or returned no data for [${searchQuery}]. Attempting Backup...`);
        try {
            const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`);
            const kitsuData = await res.json();
            const kitsuAnime = kitsuData?.data?.[0];

            if (kitsuAnime) {
                const attr = kitsuAnime.attributes;
                const kitsuId = parseInt(kitsuAnime.id); // Numerical ID fallback
                const animeTitle = attr.canonicalTitle || attr.titles?.en || searchQuery;
                const siteUrl = `https://kitsu.io/anime/${kitsuAnime.id}`;

                const existing = await FavoriteItem.findOne({ userId: interaction.user.id, animeId: kitsuId });

                if (existing) {
                    return await interaction.editReply(`⭐ **${animeTitle}** is already in your personal favorites!`);
                }

                await FavoriteItem.create({
                    userId: interaction.user.id,
                    animeId: kitsuId,
                    animeTitle: animeTitle,
                    lastEpisodes: attr.episodeCount || 0
                });

                await interaction.editReply(`⭐ Added **[${animeTitle}](${siteUrl})** to your personal favorites! You will receive DMs when new episodes drop.`);

                // Dev Alert
                const DEV_ID = '1326815636395003966';
                if (interaction.user.id === DEV_ID) {
                    await interaction.followUp({
                        content: '🚨 **[Dev Alert]:** AniList was unreachable for `/favorite`. Processed via Emergency Backup (Kitsu)!',
                        ephemeral: true
                    });
                }

                return;
            }
        } catch (backupErr) {
            console.error('Favorite Backup Fetch Error:', backupErr);
        }

        return await interaction.editReply(`❌ Anime not found for **"${searchQuery}"** on AniList or Emergency Backup. Please check the title and try again.`);
    }

    // 3. Render/Save AniList Data
    try {
        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || searchQuery;
        const existing = await FavoriteItem.findOne({ userId: interaction.user.id, animeId: anime.id });

        if (existing) {
            return await interaction.editReply(`⭐ **${animeTitle}** is already in your personal favorites!`);
        }

        await FavoriteItem.create({
            userId: interaction.user.id,
            animeId: anime.id,
            animeTitle: animeTitle,
            lastEpisodes: anime.episodes || 0
        });

        await interaction.editReply(`⭐ Added **[${animeTitle}](${anime.siteUrl})** to your personal favorites! You will receive DMs when new episodes drop.`);
    } catch (err) {
        console.error('Favorite command processing error:', err);
        await interaction.editReply('Failed to add to personal favorites.');
    }
}
    // ❌ Unfavorite Command (With Local DB Search & Emergency Fallback)
else if (commandName === 'unfavorite') {
    await interaction.deferReply({ ephemeral: true });
    const searchQuery = interaction.options.getString('title');

    // 1. Try local DB fuzzy/regex search first (Fastest & direct)
    const userFavorites = await FavoriteItem.find({ userId: interaction.user.id });
    const localMatch = userFavorites.find(item => 
        item.animeTitle.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (localMatch) {
        await FavoriteItem.deleteOne({ _id: localMatch._id });
        return await interaction.editReply(`🗑️ Removed **${localMatch.animeTitle}** from your personal favorites.`);
    }

    // 2. Try AniList API if not matched locally
    const gqlQuery = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title { romaji english }
      }
    }`;

    let anime = null;
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        anime = data?.Media;
    } catch (err) {
        console.error('Unfavorite AniList Fetch Error:', err.message);
    }

    // 3. Emergency Backup (Kitsu API) if AniList fails
    if (!anime) {
        console.log(`AniList failed or returned no data for unfavorite [${searchQuery}]. Attempting Backup...`);
        try {
            const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`);
            const kitsuData = await res.json();
            const kitsuAnime = kitsuData?.data?.[0];

            if (kitsuAnime) {
                const kitsuId = parseInt(kitsuAnime.id);
                const animeTitle = kitsuAnime.attributes?.canonicalTitle || searchQuery;

                const deleted = await FavoriteItem.findOneAndDelete({ userId: interaction.user.id, animeId: kitsuId });

                if (deleted) {
                    // Dev Alert
                    const DEV_ID = '1326815636395003966';
                    if (interaction.user.id === DEV_ID) {
                        await interaction.followUp({
                            content: '🚨 **[Dev Alert]:** AniList was unreachable for `/unfavorite`. Processed via Emergency Backup (Kitsu)!',
                            ephemeral: true
                        });
                    }
                    return await interaction.editReply(`🗑️ Removed **${deleted.animeTitle || animeTitle}** from your personal favorites.`);
                }
            }
        } catch (backupErr) {
            console.error('Unfavorite Backup Fetch Error:', backupErr);
        }

        return await interaction.editReply(`❌ Could not find **"${searchQuery}"** in your favorites or via secondary search.`);
    }

    // 4. Remove using AniList ID
    try {
        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || searchQuery;
        const deleted = await FavoriteItem.findOneAndDelete({ userId: interaction.user.id, animeId: anime.id });

        if (!deleted) {
            return await interaction.editReply(`**${animeTitle}** was not in your favorites list.`);
        }

        await interaction.editReply(`🗑️ Removed **${animeTitle}** from your personal favorites.`);
    } catch (err) {
        console.error('Unfavorite command processing error:', err);
        await interaction.editReply('Failed to remove from favorites.');
    }
}
   // 💖 My Favorites Command (Hidden/Ephemeral)
else if (commandName === 'myfavorites') {
    await interaction.deferReply({ ephemeral: true });
    try {
        const favorites = await FavoriteItem.find({ userId: interaction.user.id });
        if (!favorites || favorites.length === 0) {
            return await interaction.editReply('You currently have no anime saved in your personal favorites. Use `/favorite <title>` to add some!');
        }

        // Format list with proper limits to prevent Discord API errors
        let list = favorites.map((item, index) => `${index + 1}. **${item.animeTitle}**`).join('\n');
        
        if (list.length > 3900) {
            list = list.substring(0, 3900) + '\n\n*...and more (list truncated due to size limits).*';
        }

        const embed = new EmbedBuilder()
            .setTitle('⭐ Your Personal Favorite Anime List')
            .setDescription(list)
            .setColor('#f39c12')
            .addFields({ name: '📊 Total Favorites', value: `${favorites.length} anime`, inline: true })
            .setFooter({ text: 'AniTracker • You will receive Direct Messages when new episodes air!' });

        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('MyFavorites command error:', err);
        await interaction.editReply('Failed to fetch your personal favorites list.');
    }
}
    // 📖 Help Command
    else if (commandName === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('🤖 AniTracker - Commands Guide')
            .setDescription('Here is the full list of available slash commands:')
            .addFields(
                { name: '🚀 `/start`', value: 'Welcome guide and bug report contact.', inline: false },
                { name: '⭐ `/favorite <title>`', value: 'Add anime to personal favorites (DM notifications).', inline: false },
                { name: '❌ `/unfavorite <title>`', value: 'Remove anime from personal favorites.', inline: false },
                { name: '💖 `/myfavorites`', value: 'Show your personal favorite anime list.', inline: false },
                { name: '🔍 `/anime <title>`', value: 'Search for anime details, quick track, or add to favorites.', inline: false },
                { name: '📖 `/manga <title>`', value: 'Search for manga details.', inline: false },
                { name: '🎭 `/character <name>`', value: 'Search for anime characters.', inline: false },
                { name: '🎲 `/genre`', value: 'Choose Anime or Manga, then pick a category for a recommendation. Ecchi/Hentai require manual age verification in DMs.', inline: false },
                { name: '🎯 `/track <title>`', value: 'Track an anime for notifications in this channel.', inline: false },
                { name: '🛑 `/untrack <title>`', value: 'Stop tracking an anime in this channel.', inline: false },
                { name: '📌 `/mytracked`', value: 'Show all anime currently tracked in this server.', inline: false }
            )
            .setColor('#9b59b6')
            .setFooter({ text: "Report bugs to developer: _h8rtless_   don't dm unless it's a real problem" });

        const supportBtn = new ButtonBuilder()
            .setLabel('💬 Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.gg/H4Af2y4RD8');

        const profileBtn = new ButtonBuilder()
            .setLabel('👤 Developer Profile')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.com/users/1326815636395003966');

        const row = new ActionRowBuilder().addComponents(supportBtn, profileBtn);

        // FIX: added ephemeral so only the person who ran /help sees the reply,
        // consistent with /start, /myfavorites, and /mytracked.
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

  // 🔍 Anime Command
else if (commandName === 'anime') {
    await interaction.deferReply();
    const searchQuery = interaction.options.getString('title');

    const gqlQuery = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title { romaji english }
        episodes
        status
        averageScore
        description(asHtml: false)
        coverImage { large }
        siteUrl
        isAdult
      }
    }`;

    let anime = null;

    // 1. Try AniList First
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        anime = data?.Media;
    } catch (err) {
        console.error('AniList Fetch Error:', err.message);
    }

    // 2. Fallback to Kitsu/Jikan if AniList failed or returned no data
    if (!anime) {
        console.log('AniList failed or returned no data. Fetching from Fallback...');
        try {
            const jikanData = await getAnimeJikan(searchQuery);

            if (jikanData) {
                const fallbackEmbed = new EmbedBuilder()
                    .setTitle(jikanData.title)
                    .setURL(jikanData.url || 'https://kitsu.io')
                    .setThumbnail(jikanData.image || 'https://i.imgur.com/AGv4yDI.png')
                    .addFields(
                        { name: 'Episodes', value: `${jikanData.episodes ?? 'N/A'}`, inline: true },
                        { name: 'Status', value: jikanData.status || 'N/A', inline: true },
                        { name: 'Score', value: jikanData.score || 'N/A', inline: true }
                    )
                    .setDescription(jikanData.synopsis)
                    .setColor('#FF5733');

                // 🎯 الأزرار تظهر فقط إذا كان الأنمي مستمر (Ongoing / Current / Airing)
                let fallbackComponents = [];
                const currentStatus = (jikanData.status || '').toUpperCase();
                const isOngoing = currentStatus.includes('RELEASING') || currentStatus.includes('CURRENT') || currentStatus.includes('AIRING');

                if (isOngoing) {
                    const fallbackFavBtn = new ButtonBuilder()
                        .setCustomId(`fav_btn_${jikanData.id || searchQuery}`)
                        .setLabel('⭐ Favorite (DM Alert)')
                        .setStyle(ButtonStyle.Primary);

                    const fallbackButtons = [fallbackFavBtn];

                    // 🚫 زرار الـ Track يظهر فقط داخل السيرفرات (interaction.guildId موجود)
                    if (interaction.guildId) {
                        const fallbackTrackBtn = new ButtonBuilder()
                            .setCustomId(`track_btn_${jikanData.id || searchQuery}`)
                            .setLabel('🎯 Channel Track')
                            .setStyle(ButtonStyle.Success);
                        fallbackButtons.unshift(fallbackTrackBtn);
                    }

                    fallbackComponents = [new ActionRowBuilder().addComponents(...fallbackButtons)];
                }

                // إرسال الـ Embed والأزرار للجميع
                await interaction.editReply({ embeds: [fallbackEmbed], components: fallbackComponents });

                // إرسال إشعار مخفي للـ Dev
                const DEV_ID = '1326815636395003966';
                if (interaction.user.id === DEV_ID) {
                    await interaction.followUp({
                        content: '🚨 **[Dev Alert]:** AniList was unreachable. This response was fetched via Emergency Backup!',
                        ephemeral: true
                    });
                }

                return;
            }
        } catch (fallbackErr) {
            console.error('Fallback Error:', fallbackErr);
        }

        return await interaction.editReply('❌ Anime not found on AniList or Emergency Backup.');
    }

    // 3. Render AniList Data (If AniList succeeded)
    try {
        if (anime.isAdult) {
            let isVerified = false;
            try {
                isVerified = Boolean(await AgeVerification.exists({ userId: interaction.user.id }));
            } catch (err) {
                console.error('age verification lookup error:', err);
            }

            if (!isVerified) {
                return interaction.editReply({
                    content: `🔞 **This anime is restricted to verified adults.**\n\n` +
                             `👤 **Owner:** \`_h8rtless_\`\n` +
                             `💬 Join our support server to open a ticket and verify your age:\n` +
                             `https://discord.gg/H4Af2y4RD8`,
                    embeds: [],
                    components: []
                });
            }
        }

        const title = (anime.title && (anime.title.english || anime.title.romaji)) || searchQuery;
        const cleanDesc = anime.description ? anime.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setURL(anime.siteUrl || 'https://anilist.co')
            .setThumbnail(anime.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
            .addFields(
                { name: 'Episodes', value: `${anime.episodes ?? 'N/A'}`, inline: true },
                { name: 'Status', value: anime.status || 'N/A', inline: true },
                { name: 'Score', value: anime.averageScore ? `${anime.averageScore} / 100` : 'N/A', inline: true }
            )
            .setDescription(cleanDesc)
            .setColor('#FF5733');

        // 🎯 الأزرار تظهر فقط إذا كانت الحالة RELEASING (Ongoing)
        let components = [];
        if (anime.status === 'RELEASING') {
            const favBtn = new ButtonBuilder()
                .setCustomId(`fav_btn_${anime.id}`)
                .setLabel('⭐ Favorite (DM Alert)')
                .setStyle(ButtonStyle.Primary);

            const buttons = [favBtn];

            // 🚫 زرار الـ Track يظهر فقط داخل السيرفرات (interaction.guildId موجود)
            if (interaction.guildId) {
                const trackBtn = new ButtonBuilder()
                    .setCustomId(`track_btn_${anime.id}`)
                    .setLabel('🎯 Channel Track')
                    .setStyle(ButtonStyle.Success);
                buttons.unshift(trackBtn);
            }

            components = [new ActionRowBuilder().addComponents(...buttons)];
        }

        await interaction.editReply({ 
            embeds: [embed], 
            components: components 
        });
    } catch (err) {
        console.error('Anime Command Render Error:', err);
        await interaction.editReply('Failed to display anime data.');
    }
}
    // 🌐 أمر الـ servers بيتحط هنا على طول تحت الـ eval
    else if (commandName === 'servers') {
        if (interaction.user.id !== '1326815636395003966') {
            return interaction.reply({ content: '❌ Dev only command!', flags: 64 });
        }

        const guilds = interaction.client.guilds.cache
            .map(g => `• **${g.name}** (\`${g.id}\`) - ${g.memberCount} members`)
            .join('\n');

        await interaction.reply({
            content: `🌐 **Server List (${interaction.client.guilds.cache.size}):**\n\n${guilds.slice(0, 1900)}`,
            flags: 64
        });
    }
        // 🛠️ أمر الـ maintenance-dm
    else if (commandName === 'maintenance-dm') {
        if (interaction.user.id !== '1326815636395003966') {
            return interaction.reply({ content: '❌ Dev only command!', flags: 64 });
        }

        // سحب الرسالة اللي كتبتها في الكوماند
        const messageContent = interaction.options.getString('message');

        await interaction.deferReply({ flags: 64 });

        let successCount = 0;
        let failCount = 0;

        const users = new Set();
        interaction.client.guilds.cache.forEach(guild => {
            guild.members.cache.forEach(member => {
                if (!member.user.bot) {
                    users.add(member.user);
                }
            });
        });

        for (const user of users) {
            try {
                await user.send(`🛠️ **Bot Maintenance Announcement:**\n\n${messageContent}`);
                successCount++;
            } catch (error) {
                failCount++;
            }
        }

        await interaction.editReply({
            content: `✅ **Broadcast Complete!**\n\n• **Successfully sent:** ${successCount} users\n• **Failed (DMs closed):** ${failCount} users`
        });
    }
        else if (commandName === 'broadcast') {
    // 1. خاص بيك أنت فقط
    if (interaction.user.id !== '1326815636395003966') {
        return interaction.reply({ content: '❌ Dev only command!', flags: 64 });
    }

    const message = interaction.options.getString('message');

    // تأجيل الرد عشان البوت ياخد وقته في إرسال الرسائل من غير ما يديك Timeout
    await interaction.deferReply({ flags: 64 });

    let successCount = 0;
    let failCount = 0;

    // 2. إرسال الرسالة لكل السيرفرات أولاً
    for (const guild of interaction.client.guilds.cache.values()) {
        const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
        
        if (channel) {
            try {
                await channel.send(`📢 **[Announcement]**\n\n${message}`);
                successCount++;
            } catch (err) {
                failCount++;
            }
        } else {
            failCount++;
        }
    }

    // 3. إبلاغك بالتفاصيل والنتيجة بعد الانتهاء
    await interaction.editReply({
        content: `✅ **Broadcast Finished!**\n\n• **Sent successfully to:** ${successCount} server(s)\n• **Failed:** ${failCount} server(s)`
    });
}
    
            else if (commandName === 'getinvite') {
        if (interaction.user.id !== '1326815636395003966') {
            return interaction.reply({ content: '❌ Dev only command!', flags: 64 });
        }

        const guildId = interaction.options.getString('guild_id');
        const guild = interaction.client.guilds.cache.get(guildId);

        if (!guild) {
            return interaction.reply({ content: '❌ Server not found!', flags: 64 });
        }

        const channel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(guild.members.me).has('CreateInstantInvite'));

        if (!channel) {
            return interaction.reply({ content: '❌ Couldn\'t create invite (missing permissions).', flags: 64 });
        }

        const invite = await channel.createInvite({ maxAge: 3600, maxUses: 1 });
        await interaction.reply({ content: `🔗 **Invite Link for ${guild.name}:** ${invite.url}`, flags: 64 });
    }
                else if (commandName === 'bot-status') {
        if (interaction.user.id !== '1326815636395003966') {
            return interaction.reply({ content: '❌ Dev only command!', flags: 64 });
        }

        const activity = interaction.options.getString('activity');
        const type = parseInt(interaction.options.getString('type'));

        interaction.client.user.setActivity(activity, { type: type });

        await interaction.reply({
            content: `✅ Bot activity updated to: **${activity}**`,
            flags: 64
        });
    }
    // 📖 Manga Command
    else if (commandName === 'manga') {
        await interaction.deferReply();
        const searchQuery = interaction.options.getString('title');

        const gqlQuery = `
        query ($search: String) {
          Media (search: $search, type: MANGA) {
            id
            title { romaji english }
            chapters
            status
            averageScore
            description(asHtml: false)
            coverImage { large }
            siteUrl
            isAdult
          }
        }`;

        let manga = null;

        // 1. Try AniList First
        try {
            const data = await fetchAniList(gqlQuery, { search: searchQuery });
            manga = data?.Media;
        } catch (err) {
            console.error('AniList Manga Fetch Error:', err.message);
        }

        // 2. Fallback if AniList failed or returned no data
        if (!manga) {
            console.log('AniList failed or returned no data for Manga. Fetching from Fallback...');
            try {
                const jikanData = await getAnimeJikan(searchQuery);

                if (jikanData) {
                    const fallbackEmbed = new EmbedBuilder()
                        .setTitle(jikanData.title)
                        .setURL(jikanData.url || 'https://kitsu.io')
                        .setThumbnail(jikanData.image || 'https://i.imgur.com/AGv4yDI.png')
                        .addFields(
                            { name: 'Chapters', value: `${jikanData.chapters ?? jikanData.episodes ?? 'N/A'}`, inline: true },
                            { name: 'Status', value: jikanData.status || 'N/A', inline: true },
                            { name: 'Score', value: jikanData.score || 'N/A', inline: true }
                        )
                        .setDescription(jikanData.synopsis)
                        .setColor('#33FF57');

                    // 1. إرسال الـ Embed العادي للجميع في الشات
                    await interaction.editReply({ embeds: [fallbackEmbed], components: [] });

                    // 2. إرسال إشعار مخفي للـ Dev فقط (صهيب)
                    const DEV_ID = '1326815636395003966';

                    if (interaction.user.id === DEV_ID) {
                        await interaction.followUp({
                            content: '🚨 **[Dev Alert]:** AniList was unreachable. This manga response was fetched via the Emergency Backup (Kitsu)!',
                            ephemeral: true
                        });
                    }

                    return; // إنهاء الدالة بنجاح
                }
            } catch (fallbackErr) {
                console.error('Manga Fallback Error:', fallbackErr);
            }

            return await interaction.editReply('❌ Manga not found on AniList or Emergency Backup.');
        }

        // 3. Render AniList Data (If AniList succeeded)
        try {
            // فحص ما إذا كانت المانجا 18+
            if (manga.isAdult) {
                let isVerified = false;
                try {
                    isVerified = Boolean(await AgeVerification.exists({ userId: interaction.user.id }));
                } catch (err) {
                    console.error('age verification lookup error:', err);
                }

                if (!isVerified) {
                    return interaction.editReply({
                        content: `🔞 **This manga is restricted to verified adults.**\n\n` +
                                 `👤 **Owner:** \`_h8rtless_\`\n` +
                                 `💬 Join our support server to open a ticket and verify your age:\n` +
                                 `https://discord.gg/H4Af2y4RD8`,
                        embeds: []
                    });
                }
            }

            const title = (manga.title && (manga.title.english || manga.title.romaji)) || searchQuery;
            const cleanDesc = manga.description ? manga.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setURL(manga.siteUrl || 'https://anilist.co')
                .setThumbnail(manga.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
                .addFields(
                    { name: 'Chapters', value: `${manga.chapters ?? 'N/A'}`, inline: true },
                    { name: 'Status', value: manga.status || 'N/A', inline: true },
                    { name: 'Score', value: manga.averageScore ? `${manga.averageScore} / 100` : 'N/A', inline: true }
                )
                .setDescription(cleanDesc)
                .setColor('#33FF57');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('Manga Command Render Error:', err);
            await interaction.editReply('Failed to display manga data.');
        }
    }

    // 🎲 Genre Command
    else if (commandName === 'genre') {
        await interaction.reply({
            content: '📚 First choose what you want to discover:',
            components: [buildMediaTypeMenu()],
            ephemeral: true
        });
    }

   // 🎯 Track Command (Server Only + Emergency Fallback)
else if (commandName === 'track') {
    // 1. Strict Server Guard (Direct check before deferring reply)
    if (!interaction.guildId) {
        return interaction.reply({
            content: '🎯 `/track` works inside a server channel! Want personal alerts instead? Try `/favorite <title>` — you\'ll get a DM whenever a new episode drops.',
            flags: 64
        });
    }

    await interaction.deferReply();
    const searchQuery = interaction.options.getString('title');

    const gqlQuery = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title { romaji english }
        episodes
        status
        coverImage { large }
        siteUrl
      }
    }`;

    let anime = null;

    // 2. Try AniList First
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        anime = data?.Media;
    } catch (err) {
        console.error('Track AniList Fetch Error:', err.message);
    }

    // 3. Emergency Backup (Kitsu API) if AniList fails
    if (!anime) {
        console.log(`AniList failed or returned no data for track [${searchQuery}]. Attempting Backup...`);
        try {
            const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`);
            const kitsuData = await res.json();
            const kitsuAnime = kitsuData?.data?.[0];

            if (kitsuAnime) {
                const attr = kitsuAnime.attributes;
                const kitsuId = parseInt(kitsuAnime.id);
                const animeTitle = attr.canonicalTitle || attr.titles?.en || searchQuery;
                const coverUrl = attr.posterImage?.large || 'https://i.imgur.com/AGv4yDI.png';
                const siteUrl = `https://kitsu.io/anime/${kitsuAnime.id}`;
                const animeStatus = attr.status ? attr.status.toUpperCase() : 'UNKNOWN';

                const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: kitsuId });
                if (existing) {
                    return await interaction.editReply(`**${animeTitle}** is already being tracked in this server!`);
                }

                await TrackedItem.create({
                    guildId: interaction.guildId,
                    channelId: interaction.channelId,
                    animeId: kitsuId,
                    animeTitle: animeTitle,
                    lastEpisodes: attr.episodeCount || 0,
                    lastStatus: animeStatus
                });

                const embed = new EmbedBuilder()
                    .setTitle('🎯 Tracking Started!')
                    .setDescription(`Now tracking **[${animeTitle}](${siteUrl})** in this channel.\nYou will receive alerts here when new episodes release!`)
                    .setThumbnail(coverUrl)
                    .setColor('#3498db')
                    .setFooter({ text: 'AniTracker • Emergency Backup' });

                await interaction.editReply({ embeds: [embed] });

                // Dev Alert
                const DEV_ID = '1326815636395003966';
                if (interaction.user.id === DEV_ID) {
                    await interaction.followUp({
                        content: '🚨 **[Dev Alert]:** AniList was unreachable for `/track`. Processed via Emergency Backup (Kitsu)!',
                        flags: 64
                    });
                }

                return;
            }
        } catch (backupErr) {
            console.error('Track Backup Fetch Error:', backupErr);
        }

        return await interaction.editReply(`❌ Could not find **"${searchQuery}"** on AniList or Emergency Backup.`);
    }

    // 4. Render/Save AniList Data
    try {
        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || searchQuery;
        const animeId = anime.id;
        const animeEpisodes = anime.episodes || 0;
        const animeStatus = anime.status || 'UNKNOWN';
        const coverUrl = (anime.coverImage && anime.coverImage.large) || 'https://i.imgur.com/AGv4yDI.png';
        const siteUrl = anime.siteUrl || 'https://anilist.co';

        const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: animeId });
        if (existing) {
            return await interaction.editReply(`**${animeTitle}** is already being tracked in this server!`);
        }

        await TrackedItem.create({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            animeId: animeId,
            animeTitle: animeTitle,
            lastEpisodes: animeEpisodes,
            lastStatus: animeStatus
        });

        const embed = new EmbedBuilder()
            .setTitle('🎯 Tracking Started!')
            .setDescription(`Now tracking **[${animeTitle}](${siteUrl})** in this channel.\nYou will receive alerts here when new episodes release!`)
            .setThumbnail(coverUrl)
            .setColor('#3498db');

        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('Track Command Error:', err);
        await interaction.editReply(`Failed to track this anime.`);
    }
}
   // 🛑 Untrack Command (Server Only + Local DB Search + Emergency Fallback)
else if (commandName === 'untrack') {
    // 1. Strict Server Guard
    if (!interaction.guildId) {
        return interaction.reply({
            content: '🛑 `/untrack` only works inside a server channel!',
            flags: 64
        });
    }

    await interaction.deferReply();
    const searchQuery = interaction.options.getString('title');

    // 2. Try local DB fuzzy search first (Fastest & direct match for this server)
    const trackedItems = await TrackedItem.find({ guildId: interaction.guildId });
    const localMatch = trackedItems.find(item => 
        item.animeTitle.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (localMatch) {
        await TrackedItem.deleteOne({ _id: localMatch._id });
        return await interaction.editReply(`🛑 Stopped tracking **${localMatch.animeTitle}** in this server.`);
    }

    // 3. Try AniList API if not matched locally
    const gqlQuery = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title { romaji english }
      }
    }`;

    let anime = null;
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        anime = data?.Media;
    } catch (err) {
        console.error('Untrack AniList Fetch Error:', err.message);
    }

    // 4. Emergency Backup (Kitsu API) if AniList fails
    if (!anime) {
        console.log(`AniList failed or returned no data for untrack [${searchQuery}]. Attempting Backup...`);
        try {
            const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`);
            const kitsuData = await res.json();
            const kitsuAnime = kitsuData?.data?.[0];

            if (kitsuAnime) {
                const kitsuId = parseInt(kitsuAnime.id);
                const animeTitle = kitsuAnime.attributes?.canonicalTitle || searchQuery;

                const deleted = await TrackedItem.findOneAndDelete({ guildId: interaction.guildId, animeId: kitsuId });

                if (deleted) {
                    // Dev Alert
                    const DEV_ID = '1326815636395003966';
                    if (interaction.user.id === DEV_ID) {
                        await interaction.followUp({
                            content: '🚨 **[Dev Alert]:** AniList was unreachable for `/untrack`. Processed via Emergency Backup (Kitsu)!',
                            flags: 64
                        });
                    }
                    return await interaction.editReply(`🛑 Stopped tracking **${deleted.animeTitle || animeTitle}** in this server.`);
                }
            }
        } catch (backupErr) {
            console.error('Untrack Backup Fetch Error:', backupErr);
        }

        return await interaction.editReply(`❌ Could not find **"${searchQuery}"** in this server's tracking list.`);
    }

    // 5. Remove using AniList ID
    try {
        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || searchQuery;
        const deleted = await TrackedItem.findOneAndDelete({ guildId: interaction.guildId, animeId: anime.id });

        if (!deleted) {
            return await interaction.editReply(`**${animeTitle}** was not being tracked in this server.`);
        }

        await interaction.editReply(`🛑 Stopped tracking **${animeTitle}**.`);
    } catch (err) {
        console.error('Untrack command error:', err);
        await interaction.editReply('Failed to untrack this anime.');
    }
}
    // 📌 List Tracked Command (Hidden/Ephemeral)
else if (commandName === 'mytracked') {
    // 1. Strict Server Guard
    if (!interaction.guildId) {
        return interaction.reply({
            content: '📌 `/mytracked` only works inside a server!',
            flags: 64
        });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const items = await TrackedItem.find({ guildId: interaction.guildId });
        if (!items || items.length === 0) {
            return await interaction.editReply('No anime is currently being tracked in this server. Use `/track <title>` to start tracking!');
        }

        // Format list with length safety
        let list = items.map((item, index) => `${index + 1}. **${item.animeTitle}** (Channel: <#${item.channelId}>)`).join('\n');
        
        if (list.length > 3900) {
            list = list.substring(0, 3900) + '\n\n*...and more (list truncated due to size limits).*';
        }

        const embed = new EmbedBuilder()
            .setTitle('📌 Tracked Anime List')
            .setDescription(list)
            .setColor('#f1c40f')
            .addFields({ name: '📊 Total Tracked', value: `${items.length} anime`, inline: true })
            .setFooter({ text: 'AniTracker • Automated Server Alerts' });

        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('MyTracked Command Error:', err);
        await interaction.editReply('Failed to fetch tracked list.');
    }
}
    // 🧪 Test Alert Command (Dev Only)
else if (commandName === 'testalert') {
    const DEV_ID = process.env.DEV_USER_ID || '1326815636395003966';

    // 1. Strict Developer Guard
    if (interaction.user.id !== DEV_ID) {
        return interaction.reply({
            content: '🚫 This command is reserved for the bot developer only.',
            flags: 64
        });
    }

    await interaction.deferReply({ flags: 64 });

    try {
        console.log(`[Dev Action]: ${interaction.user.tag} triggered manual checkUpdates()...`);
        
        // 2. Trigger automated checker
        await checkUpdates();

        await interaction.editReply('✅ **Manual check complete!** Check your tracked channels and personal DMs for any new episode alerts.');
    } catch (err) {
        console.error('testalert command error:', err);
        await interaction.editReply('❌ `checkUpdates()` encountered an error during manual execution. Check the console logs for full details.');
    }
}

// 🔄 Automated Episode Checker Function
async function checkUpdates() {
    try {
        // 1. Check Channel Tracked Items (Server Trackers)
        const tracked = await TrackedItem.find({});
        
        for (const item of tracked) {
            try {
                const gqlQuery = `
                query ($id: Int) {
                  Media (id: $id, type: ANIME) {
                    id
                    title { romaji english }
                    episodes
                    status
                    coverImage { large }
                    siteUrl
                    nextAiringEpisode { episode }
                  }
                }`;

                const data = await fetchAniList(gqlQuery, { id: item.animeId });
                const anime = data?.Media;

                if (anime) {
                    const currentEps = getAiredEpisodes(anime);
                    const lastEps = item.lastEpisodes || 0;

                    if (currentEps > lastEps) {
                        const channel = await client.channels.fetch(item.channelId).catch(() => null);

                        if (channel) {
                            const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || item.animeTitle;
                            const siteUrl = anime.siteUrl || 'https://anilist.co';
                            const coverUrl = (anime.coverImage && anime.coverImage.large) || 'https://i.imgur.com/AGv4yDI.png';

                            const embed = new EmbedBuilder()
                                .setTitle('🚨 New Episode Alert!')
                                .setDescription(`**[${animeTitle}](${siteUrl})** has released new episode(s)!\n\n📺 **Current Episodes:** ${currentEps}`)
                                .setThumbnail(coverUrl)
                                .setColor('#e74c3c')
                                .setTimestamp();

                            await channel.send({ embeds: [embed] }).catch((err) => {
                                console.error(`Failed to send alert to channel ${item.channelId}:`, err.message);
                            });

                            // Update Database after attempting to send
                            item.lastEpisodes = currentEps;
                            item.lastStatus = anime.status || item.lastStatus;
                            await item.save();
                        } else {
                            // Channel was deleted or inaccessible - clean up DB
                            console.log(`Channel ${item.channelId} inaccessible. Removing tracked item...`);
                            await TrackedItem.deleteOne({ _id: item._id });
                        }
                    }
                }
            } catch (err) {
                console.error(`Error checking channel update for anime ID ${item.animeId}:`, err.message);
            }

            await sleep(350); // Safe pacing for AniList Rate Limit
        }

        // 2. Check Personal Favorites (User DM Alerts)
        const favorites = await FavoriteItem.find({});

        for (const item of favorites) {
            try {
                const gqlQuery = `
                query ($id: Int) {
                  Media (id: $id, type: ANIME) {
                    id
                    title { romaji english }
                    episodes
                    status
                    coverImage { large }
                    siteUrl
                    nextAiringEpisode { episode }
                  }
                }`;

                const data = await fetchAniList(gqlQuery, { id: item.animeId });
                const anime = data?.Media;

                if (anime) {
                    const currentEps = getAiredEpisodes(anime);
                    const lastEps = item.lastEpisodes || 0;

                    if (currentEps > lastEps) {
                        const user = await client.users.fetch(item.userId).catch(() => null);

                        if (user) {
                            const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || item.animeTitle;
                            const siteUrl = anime.siteUrl || 'https://anilist.co';
                            const coverUrl = (anime.coverImage && anime.coverImage.large) || 'https://i.imgur.com/AGv4yDI.png';

                            const embed = new EmbedBuilder()
                                .setTitle('⭐ Favorite Anime Update!')
                                .setDescription(`A new episode of **[${animeTitle}](${siteUrl})** is out!\n\n📺 **Current Episodes:** ${currentEps}`)
                                .setThumbnail(coverUrl)
                                .setColor('#f1c40f')
                                .setTimestamp();

                            // Send DM (catch error if user closed DMs)
                            await user.send({ embeds: [embed] }).catch(() => {
                                console.log(`Could not send DM to user ${item.userId} (DMs might be closed).`);
                            });
                        }

                        // Always update database so it doesn't loop forever
                        item.lastEpisodes = currentEps;
                        await item.save();
                    }
                }
            } catch (err) {
                console.error(`Error checking DM update for user ${item.userId}:`, err.message);
            }

            await sleep(350);
        }
    } catch (err) {
        console.error('Error in checkUpdates main loop:', err);
   }

}
});
// Log in to Discord
client.login(process.env.DISCORD_TOKEN);
