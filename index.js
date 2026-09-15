const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, PermissionFlagsBits, ChannelType } = require('discord.js');
const axios = require('axios');
const http = require('http');
const mongoose = require('mongoose');
require('dotenv').config();
const { getAnimeJikan, getMangaJikan, getCharacterJikan } = require('./jikanFallback');
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
    animeId: String,
    animeTitle: String,
    mediaType: { type: String, enum: ['anime', 'manga'], default: 'anime' },
    lastEpisodes: Number,
    lastStatus: String,
    source: { type: String, default: 'anilist' }
});
const TrackedItem = mongoose.model('TrackedItem', TrackSchema);

// MongoDB Schema for Personal Favorites (DM Alerts)
const FavoriteSchema = new mongoose.Schema({
    userId: String,
    animeId: String,
    animeTitle: String,
    mediaType: { type: String, enum: ['anime', 'manga'], default: 'anime' },
    lastEpisodes: Number,
    source: { type: String, default: 'anilist' }
});
const FavoriteItem = mongoose.model('FavoriteItem', FavoriteSchema);

async function findExistingFavorite(userId, animeId, animeTitle) {
    return FavoriteItem.findOne({
        userId,
        $or: [
            { animeId: String(animeId) },
            { animeTitle }
        ]
    });
}

async function fetchMangaDexSearch(search) {
    const response = await axios.get('https://api.mangadex.org/manga', {
        params: {
            title: search,
            limit: 1,
            'includes[]': 'cover_art',
            'contentRating[]': ['safe', 'suggestive', 'erotica']
        },
        timeout: 10000
    });
    const item = response.data?.data?.[0];
    if (!item) return null;

    const attributes = item.attributes || {};
    const title = attributes.title?.en
        || Object.values(attributes.title || {})[0]
        || search;
    const description = attributes.description?.en
        || Object.values(attributes.description || {})[0]
        || 'No synopsis available.';
    const cover = item.relationships?.find(relation => relation.type === 'cover_art');
    const coverUrl = cover?.attributes?.fileName
        ? `https://uploads.mangadex.org/covers/${item.id}/${cover.attributes.fileName}.256.jpg`
        : 'https://i.imgur.com/AGv4yDI.png';

    return {
        id: item.id,
        title,
        description,
        status: attributes.status?.toUpperCase() || 'UNKNOWN',
        chapters: attributes.lastChapter || 0,
        volumes: attributes.lastVolume || 0,
        image: coverUrl,
        siteUrl: `https://mangadex.org/title/${item.id}`,
        source: 'mangadex'
    };
}

async function fetchMangaDexLatestChapter(mangaId) {
    const response = await axios.get('https://api.mangadex.org/chapter', {
        params: {
            'manga[]': mangaId,
            'translatedLanguage[]': 'en',
            'order[chapter]': 'desc',
            limit: 1
        },
        timeout: 10000
    });
    const chapter = response.data?.data?.[0]?.attributes?.chapter;
    const numericChapter = Number.parseFloat(chapter);
    return Number.isFinite(numericChapter) ? numericChapter : 0;
}

const UserSettingsSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    timezone: { type: String, default: 'UTC' },
    favoriteDmsEnabled: { type: Boolean, default: true }
});
const UserSettings = mongoose.model('UserSettings', UserSettingsSchema);

const ServerSettingsSchema = new mongoose.Schema({
    guildId: { type: String, unique: true },
    alertChannelId: String,
    botRoleId: String,
    serverAlertsEnabled: { type: Boolean, default: true }
});
const ServerSettings = mongoose.model('ServerSettings', ServerSettingsSchema);

// Manual age verification for the 18+ recommendation categories.
const AgeVerificationSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    verifiedAt: { type: Date, default: Date.now },
    verifiedBy: String
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

function canRunServerSetup(interaction) {
    const botOwnerId = process.env.DEV_USER_ID || '1326815636395003966';
    return interaction.user.id === botOwnerId
        || interaction.user.id === interaction.guild?.ownerId
        || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function buildMediaTypeMenu(status) {
    const statusSuffix = status || 'all';
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`genre_media_select_${statusSuffix}`)
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

function buildGenreMenu(mediaType, status) {
    const statusSuffix = status || 'all';
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`genre_select_${mediaType}_${statusSuffix}`)
        .setPlaceholder(`Choose a ${mediaType} category`)
        .addOptions(GENRE_OPTIONS.map(option => ({
            label: option.label,
            value: option.value,
            description: option.description
        })));

    return new ActionRowBuilder().addComponents(menu);
}

function buildSettingsMenu() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('settings_select')
        .setPlaceholder('Choose a setting to change')
        .addOptions(
            {
                label: 'Timezone',
                value: 'timezone',
                description: 'Set the timezone used for your schedule'
            },
            {
                label: 'Alert Channel',
                value: 'alert-channel',
                description: 'Choose where server episode alerts are sent'
            },
            {
                label: 'Notifications',
                value: 'notifications',
                description: 'Enable or disable DM and server alerts'
            }
        );

    return new ActionRowBuilder().addComponents(menu);
}

function buildNotificationButtons() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('settings_favorite_dms_on')
                .setLabel('Enable Favorite DMs')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('settings_favorite_dms_off')
                .setLabel('Disable Favorite DMs')
                .setStyle(ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('settings_server_alerts_on')
                .setLabel('Enable Server Alerts')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('settings_server_alerts_off')
                .setLabel('Disable Server Alerts')
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

function buildSetupChannelMenu() {
    const menu = new ChannelSelectMenuBuilder()
        .setCustomId('setup_alert_channel_select')
        .setPlaceholder('Choose the tracking and alert channel')
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);

    return new ActionRowBuilder().addComponents(menu);
}

function buildSavedMediaMenu(customId, items, placeholder) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(items.slice(0, 25).map(item => ({
            label: `${item.mediaType === 'manga' ? 'Manga' : 'Anime'}: ${item.animeTitle}`.substring(0, 100),
            value: String(item._id)
        })));
    return new ActionRowBuilder().addComponents(menu);
}

function buildSavedMediaTypeMenu(customId, items, placeholder) {
    const mediaTypes = [...new Set(items.map(item => item.mediaType || 'anime'))];
    const menu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(mediaTypes.map(mediaType => ({
            label: mediaType === 'manga' ? 'Saved Manga' : 'Saved Anime',
            value: mediaType,
            description: mediaType === 'manga'
                ? 'View your saved manga'
                : 'View your saved anime'
        })));
    return new ActionRowBuilder().addComponents(menu);
}

function buildSavedMediaComponents(customId, items, placeholder, resetKind) {
    const components = [buildSavedMediaTypeMenu(customId, items, placeholder)];
    if (items.length > 0) {
        components.push(buildResetButton(resetKind));
    }
    return components;
}

function buildResetButton(kind) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`reset_${kind}`)
            .setLabel(`🗑️ Reset all saved ${kind}`)
            .setStyle(ButtonStyle.Danger)
    );
}

function buildResetConfirmation(kind) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`reset_confirm_${kind}`)
            .setLabel('Yes, delete everything')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`reset_cancel_${kind}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );
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

let updateChecker = async () => {
    console.warn('Update checker is not ready yet.');
};

// دالة جلب البيانات عبر Vercel Proxy
async function fetchAniList(query, variables) {
    for (let attempt = 1; attempt <= 3; attempt++) {
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

            if (response.data?.errors?.length) {
                throw new Error(response.data.errors[0].message || 'AniList GraphQL error');
            }

            if (response.data?.data) {
                return response.data.data;
            }
            return null;
        } catch (error) {
            if (attempt === 3) {
                console.error('Proxy Fetch Error:', error.response ? error.response.status : error.message);
                return null;
            }
            await sleep(attempt * 350);
        }
    }
}

function cleanMediaDescription(description, maxLength = 180) {
    const clean = (description || 'No synopsis available.')
        .replace(/<[^>]*>?/gm, '')
        .replace(/~!/g, '')
        .replace(/!~/g, '')
        .trim();
    return clean.length > maxLength ? `${clean.substring(0, maxLength).trim()}...` : clean;
}

function buildMediaButtons(media, interaction, mediaType = 'anime', alreadyViewed = false) {
    const id = String(media.id);
    const buttons = [];

    const isFinished = ['FINISHED', 'CANCELLED', 'COMPLETED'].includes(media.status);
    if (!isFinished) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`${mediaType === 'manga' ? 'manga_' : ''}fav_btn_${id}`)
            .setLabel('⭐ Favorite')
            .setStyle(ButtonStyle.Primary));
        if (interaction.guildId) {
            buttons.unshift(new ButtonBuilder()
                .setCustomId(`${mediaType === 'manga' ? 'manga_' : ''}track_btn_${id}`)
                .setLabel('🎯 Track')
                .setStyle(ButtonStyle.Success));
        }
    }

    buttons.push(new ButtonBuilder()
        .setCustomId(`more_info_${id}_${mediaType}`)
        .setLabel(alreadyViewed ? '📘 Details Opened' : '📖 More Info')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(alreadyViewed));

    if (media.siteUrl) {
        buttons.push(new ButtonBuilder()
            .setLabel('🔗 Share')
            .setStyle(ButtonStyle.Link)
            .setURL(media.siteUrl));
    }

    if (mediaType === 'anime' && media.trailer?.site === 'youtube' && media.trailer?.id) {
        buttons.push(new ButtonBuilder()
            .setLabel('▶️ Trailer')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://www.youtube.com/watch?v=${media.trailer.id}`));
    }

    return [new ActionRowBuilder().addComponents(buttons.slice(0, 5))];
}

async function fetchKitsuAnime(id) {
    const response = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(id)}`);
    if (!response.ok) {
        return null;
    }

    const data = await response.json();
    const anime = data?.data;
    if (!anime?.attributes) {
        return null;
    }

    return {
        title: anime.attributes.canonicalTitle || anime.attributes.titles?.en,
        episodes: anime.attributes.episodeCount || 0,
        status: anime.attributes.status?.toUpperCase() || 'UNKNOWN',
        image: anime.attributes.posterImage?.large,
        siteUrl: `https://kitsu.io/anime/${anime.id}`
    };
}

// Helper لمعرفة عدد الحلقات المعروضة بالفعل
function getAiredEpisodes(anime) {
    if (anime.status === 'RELEASING' && anime.nextAiringEpisode?.episode) {
        return anime.nextAiringEpisode.episode - 1;
    }
    return anime.episodes || 0;
}

function isValidTimezone(timezone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
        return true;
    } catch {
        return false;
    }
}

const CITY_TIMEZONES = new Map([
    ['cairo', 'Africa/Cairo'],
    ['alexandria', 'Africa/Cairo'],
    ['casablanca', 'Africa/Casablanca'],
    ['lagos', 'Africa/Lagos'],
    ['johannesburg', 'Africa/Johannesburg'],
    ['nairobi', 'Africa/Nairobi'],
    ['london', 'Europe/London'],
    ['paris', 'Europe/Paris'],
    ['berlin', 'Europe/Berlin'],
    ['rome', 'Europe/Rome'],
    ['madrid', 'Europe/Madrid'],
    ['istanbul', 'Europe/Istanbul'],
    ['moscow', 'Europe/Moscow'],
    ['riyadh', 'Asia/Riyadh'],
    ['dubai', 'Asia/Dubai'],
    ['abu dhabi', 'Asia/Dubai'],
    ['doha', 'Asia/Qatar'],
    ['kuwait city', 'Asia/Kuwait'],
    ['baghdad', 'Asia/Baghdad'],
    ['tehran', 'Asia/Tehran'],
    ['karachi', 'Asia/Karachi'],
    ['mumbai', 'Asia/Kolkata'],
    ['delhi', 'Asia/Kolkata'],
    ['new delhi', 'Asia/Kolkata'],
    ['dhaka', 'Asia/Dhaka'],
    ['bangkok', 'Asia/Bangkok'],
    ['singapore', 'Asia/Singapore'],
    ['beijing', 'Asia/Shanghai'],
    ['shanghai', 'Asia/Shanghai'],
    ['tokyo', 'Asia/Tokyo'],
    ['seoul', 'Asia/Seoul'],
    ['sydney', 'Australia/Sydney'],
    ['melbourne', 'Australia/Melbourne'],
    ['auckland', 'Pacific/Auckland'],
    ['new york', 'America/New_York'],
    ['washington', 'America/New_York'],
    ['chicago', 'America/Chicago'],
    ['denver', 'America/Denver'],
    ['los angeles', 'America/Los_Angeles'],
    ['san francisco', 'America/Los_Angeles'],
    ['toronto', 'America/Toronto'],
    ['vancouver', 'America/Vancouver'],
    ['mexico city', 'America/Mexico_City'],
    ['sao paulo', 'America/Sao_Paulo'],
    ['buenos aires', 'America/Argentina/Buenos_Aires']
]);

function resolveTimezone(input) {
    const normalized = input.trim().toLowerCase().replace(/\s+/g, ' ');
    return CITY_TIMEZONES.get(normalized) || input.trim();
}

async function getServerAlertChannelId(guildId, fallbackChannelId) {
    const settings = await ServerSettings.findOne({ guildId }).lean();
    return settings?.alertChannelId || fallbackChannelId;
}

module.exports = {
    fetchAniList,
    sleep,
    getAiredEpisodes
};
// Register Slash Commands
const allCommands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Welcome guide, basic features, and support contact'),
    new SlashCommandBuilder()
        .setName('favorite')
        .setDescription('Add an anime to your personal favorites (Receive DM notifications)')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title to add to favorites')
                .setAutocomplete(true)
                .setRequired(true))
        .addStringOption(option =>
            option.setName('media')
                .setDescription('Save anime or manga')
                .addChoices({ name: 'Anime', value: 'anime' }, { name: 'Manga', value: 'manga' })
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('fav')
        .setDescription('Add an anime to your personal favorites (Receive DM notifications)')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title to add to favorites')
                .setAutocomplete(true)
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
                .setAutocomplete(true)
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('manga')
        .setDescription('Search for a manga')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Manga title')
                .setAutocomplete(true)
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('character')
        .setDescription('Search for an anime character')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Character name')
                .setAutocomplete(true)
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
    .setDescription('(Owner only) List all servers the bot is currently in'),
    new SlashCommandBuilder()
    .setName('broadcast')
    .setDescription('(Owner only) Broadcast an announcement message to all servers')
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
                .setAutocomplete(true)
                .setRequired(true))
        .addStringOption(option =>
            option.setName('media')
                .setDescription('Track anime or manga')
                .addChoices({ name: 'Anime', value: 'anime' }, { name: 'Manga', value: 'manga' })
                .setRequired(false)),
    new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('📅 Displays today\'s anime release schedule!'),
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Set up AniTracker permissions and the server alert channel'),
    new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Open the AniTracker settings menu'),
    new SlashCommandBuilder()
    .setName('verification-status')
    .setDescription('Check your 18+ content verification status'),
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
        .setDescription('(Dev only) Manually run the episode-alert check right now'),
        new SlashCommandBuilder()
            .setName('health')
            .setDescription('(Owner only) Check AniTracker service health'),
    new SlashCommandBuilder()
        .setName('unverify')
        .setDescription('(Owner only) Remove 18+ age verification for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to unverify')
                .setRequired(true)),
     new SlashCommandBuilder()
        .setName('maintenance-dm')
        .setDescription('(Dev only) send a dm msg to all servers and users')
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
    ),
    new SlashCommandBuilder()
        .setName('eval')
        .setDescription('(Owner only) Evaluate JavaScript code')
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
    ),
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('(Owner only) Approve a user for 18+ genre recommendations')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User who completed age verification in DMs')
                .setRequired(true))
].map(command => command.toJSON());

const OWNER_COMMAND_NAMES = new Set([
    'servers',
    'eval',
    'broadcast',
    'maintenance-dm',
    'bot-status',
    'getinvite',
    'testalert',
    'health'
]);
const SERVER_ONLY_OWNER_COMMAND_NAMES = new Set(['verify', 'unverify']);
const commands = allCommands.filter(command =>
    !OWNER_COMMAND_NAMES.has(command.name) && !SERVER_ONLY_OWNER_COMMAND_NAMES.has(command.name)
);
const ownerCommands = allCommands.filter(command =>
    OWNER_COMMAND_NAMES.has(command.name) || SERVER_ONLY_OWNER_COMMAND_NAMES.has(command.name)
).map(command => ({
    ...command,
    default_member_permissions: PermissionFlagsBits.Administrator.toString()
}));
const globalOwnerCommands = allCommands
    .filter(command => OWNER_COMMAND_NAMES.has(command.name))
    .map(command => ({
        ...command,
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    }));

const BOT_OWNER_ID = process.env.DEV_USER_ID || '1326815636395003966';

async function sendDevAlert(interaction, message) {
    const ownerId = process.env.DEV_USER_ID || '1326815636395003966';
    const content = `🚨 **[Dev Alert]** ${message}`;

    if (interaction.user?.id === ownerId) {
        try {
            return await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } catch (err) {
            console.warn('Could not show Dev Alert:', err.message);
            return;
        }
    }

    try {
        const owner = await interaction.client.users.fetch(ownerId);
        await owner.send(content);
    } catch (err) {
        console.warn('Could not send Dev Alert DM:', err.message);
    }
}

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    client.user.setActivity('AniList for new episodes 📺', { type: ActivityType.Watching });
    client.user.setStatus('online');

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [...commands, ...globalOwnerCommands] }
        );
        console.log('Successfully reloaded application (/) commands!');

        for (const guild of client.guilds.cache.values()) {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guild.id),
                { body: ownerCommands }
            );
        }
        console.log('Registered owner-only commands with administrator visibility.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
    // Background Tracker Loop (Checks every 30 minutes)
    setInterval(() => updateChecker(), 30 * 60 * 1000);
});

client.on('guildCreate', async guild => {
    const welcome = new EmbedBuilder()
        .setTitle('🎉 Thanks for adding AniTracker!')
        .setDescription('Your anime companion is ready. Start with these commands:')
        .addFields(
            { name: '🔎 Discover', value: '`/anime` • `/manga` • `/character` • `/genre`' },
            { name: '📢 Server Alerts', value: 'Run `/setup` to choose an alert channel, then use `/track`.' },
            { name: '⚙️ Personal Settings', value: '`/settings` • `/schedule` • `/favorite`' },
            { name: '📖 Need Help?', value: 'Use `/help` or join the support server below.' }
        )
        .setColor('#2ecc71')
        .setFooter({ text: 'AniTracker • Ready to explore' });
    const supportButton = new ButtonBuilder()
        .setLabel('💬 Support Server')
        .setStyle(ButtonStyle.Link)
        .setURL('https://discord.gg/H4Af2y4RD8');
    const channel = guild.systemChannel
        || guild.channels.cache.find(candidate =>
            candidate.isTextBased() && candidate.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
        );
    if (!channel) return;
    try {
        await channel.send({
            embeds: [welcome],
            components: [new ActionRowBuilder().addComponents(supportButton)]
        });
    } catch (err) {
        console.error(`Could not send welcome message in guild ${guild.id}:`, err.message);
    }
});

client.on('interactionCreate', async interaction => {
   updateChecker = runUpdateChecks;
   // 🎲 Genre recommendation menus & 🔘 Handle Interactive Buttons
if (interaction.isStringSelectMenu()) {
   if (interaction.customId === 'myfavorites_type_select') {
       const favorites = await FavoriteItem.find({
           userId: interaction.user.id,
           mediaType: interaction.values[0]
       }).lean();
       if (!favorites.length) {
           return interaction.update({
               content: '❌ There are no saved items of that type.',
               components: []
           });
       }
       return interaction.update({
           content: `⭐ Choose a saved ${interaction.values[0] === 'manga' ? 'manga' : 'anime'} to view its details:`,
           components: [
               buildSavedMediaMenu('myfavorites_select', favorites, 'Choose a saved item'),
               buildResetButton('favorites')
           ]
       });
   }

   if (interaction.customId === 'myfavorites_select') {
        const favorite = await FavoriteItem.findOne({
            _id: interaction.values[0],
            userId: interaction.user.id
        }).lean();
        if (!favorite) {
            return interaction.update({ content: '❌ That saved item is no longer available.', components: [] });
        }
        return interaction.update({
            content: `⭐ **${favorite.animeTitle}**\nType: **${favorite.mediaType === 'manga' ? 'Manga' : 'Anime'}**\nUse \`/unfavorite ${favorite.animeTitle}\` to remove it.`,
            components: []
        });
    }

    if (interaction.customId === 'mytracked_select') {
        const trackedItem = await TrackedItem.findOne({
            _id: interaction.values[0],
            guildId: interaction.guildId
        }).lean();
        if (!trackedItem) {
            return interaction.update({ content: '❌ That tracked item is no longer available.', components: [] });
        }
        return interaction.update({
            content: `🎯 **${trackedItem.animeTitle}**\nType: **${trackedItem.mediaType === 'manga' ? 'Manga' : 'Anime'}**\nAlerts: <#${trackedItem.channelId}>`,
            components: []
        });
    }

    if (interaction.customId === 'mytracked_type_select') {
        const items = await TrackedItem.find({
            guildId: interaction.guildId,
            mediaType: interaction.values[0]
        }).lean();
        if (!items.length) {
            return interaction.update({
                content: '❌ There are no tracked items of that type.',
                components: []
            });
        }
        return interaction.update({
            content: `📌 Choose a tracked ${interaction.values[0] === 'manga' ? 'manga' : 'anime'} to view its details:`,
            components: [
                buildSavedMediaMenu('mytracked_select', items, 'Choose a tracked item'),
                buildResetButton('tracked')
            ]
        });
    }

    if (interaction.customId === 'settings_select') {
        const setting = interaction.values[0];

        if (setting === 'timezone') {
            const modal = new ModalBuilder()
                .setCustomId('settings_timezone_modal')
                .setTitle('Set Your Timezone');
            const timezoneInput = new TextInputBuilder()
                .setCustomId('timezone')
                .setLabel('City or IANA timezone')
                .setPlaceholder('Cairo, Dubai, New York, or Africa/Cairo')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(timezoneInput));
            return interaction.showModal(modal);
        }

        if (setting === 'alert-channel') {
            if (!interaction.guildId) {
                return interaction.update({
                    content: '❌ Alert channel settings can only be changed inside a server.',
                    components: []
                });
            }
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.update({
                    content: '❌ You need **Manage Channels** permission to change the server alert channel.',
                    components: []
                });
            }

            const channelMenu = new ChannelSelectMenuBuilder()
                .setCustomId('settings_alert_channel_select')
                .setPlaceholder('Choose the alert channel')
                .addChannelTypes(ChannelType.GuildText)
                .setMinValues(1)
                .setMaxValues(1);
            return interaction.update({
                content: '📢 Choose the server channel for tracked anime alerts:',
                components: [new ActionRowBuilder().addComponents(channelMenu)]
            });
        }

        return interaction.update({
            content: '🔔 Choose which notification type to change:',
            components: buildNotificationButtons()
        });
    }

    if (interaction.customId.startsWith('genre_media_select_')) {
        const mediaType = interaction.values[0];
        const status = interaction.customId.replace('genre_media_select_', '');
        return interaction.update({
            content: `📚 You chose **${mediaType === 'anime' ? 'Anime' : 'Manga'}**. Now choose a category:`,
            components: [buildGenreMenu(mediaType, status === 'all' ? null : status)]
        });
    }

    if (interaction.customId.startsWith('genre_select_')) {
        const [, , mediaType, statusValue = 'all'] = interaction.customId.split('_');
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
              trailer { id site }
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
                status: statusValue === 'all' ? null : statusValue
            });
            mediaList = data?.Page?.media;
        } catch (err) {
            console.error('Genre AniList Fetch Error:', err.message);
        }

        // 2. Fallback (If AniList failed or returned no data)
        if (!mediaList || mediaList.length === 0) {
            console.log(`AniList failed for genre [${genreDefinition.label}]. Attempting Fallback...`);
            try {
                const jikanData = mediaType === 'manga'
                    ? await getMangaJikan(genreDefinition.label)
                    : await getAnimeJikan(genreDefinition.label);

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
                        .setDescription('Click **More Info** on the AniList result for the full synopsis and details.')
                        .setColor(genreDefinition.adultOnly ? '#8e44ad' : '#1abc9c');

                    await interaction.editReply({ content: '', embeds: [fallbackEmbed], components: [] });

                    await sendDevAlert(interaction, 'AniList genre lookup was unreachable. Recommendation fetched via Emergency Backup.');

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
                .setDescription('Click **More Info** for the full synopsis and details.')
                .setColor(genreDefinition.adultOnly ? '#8e44ad' : '#1abc9c');

            const components = [];
            components.push(...buildMediaButtons(media, interaction, mediaType));

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

if (interaction.isChannelSelectMenu() && interaction.customId === 'settings_alert_channel_select') {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.update({
            content: '❌ You need **Manage Channels** permission to change the server alert channel.',
            components: []
        });
    }

    const channelId = interaction.values[0];
    await ServerSettings.findOneAndUpdate(
        { guildId: interaction.guildId },
        { $set: { alertChannelId: channelId, serverAlertsEnabled: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await TrackedItem.updateMany(
        { guildId: interaction.guildId },
        { $set: { channelId } }
    );

    return interaction.update({
        content: `✅ Server episode alerts will now be sent to <#${channelId}>.`,
        components: []
    });
}

if (interaction.isChannelSelectMenu() && interaction.customId === 'setup_alert_channel_select') {
    if (!interaction.guildId || !canRunServerSetup(interaction)) {
        return interaction.update({
            content: '❌ Only the server owner, an administrator, or the bot owner can finish AniTracker setup.',
            components: []
        });
    }

    const channelId = interaction.values[0];
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const botMember = await interaction.guild.members.fetch(client.user.id).catch(() => null);
    if (!channel || !botMember) {
        return interaction.update({
            content: '❌ I could not verify the selected channel. Please run `/setup` again.',
            components: []
        });
    }

    const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory
    ];
    const permissions = channel.permissionsFor(botMember);
    const missingPermissions = requiredPermissions.filter(permission => !permissions?.has(permission));

    if (missingPermissions.length > 0) {
        return interaction.update({
            content: `❌ I cannot send alerts in <#${channelId}>. Grant the bot **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** permissions, then run \`/setup\` again.`,
            components: []
        });
    }

    await ServerSettings.findOneAndUpdate(
        { guildId: interaction.guildId },
        { $set: { alertChannelId: channelId, serverAlertsEnabled: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await TrackedItem.updateMany(
        { guildId: interaction.guildId },
        { $set: { channelId } }
    );

    return interaction.update({
        content: `✅ AniTracker setup is complete!\n\n📢 Tracking and episode alerts will use <#${channelId}>.\n\nYou can change this later with \`/settings\` → **Alert Channel**.`,
        components: []
    });
}

if (interaction.isModalSubmit() && interaction.customId === 'settings_timezone_modal') {
    const input = interaction.fields.getTextInputValue('timezone').trim();
    const timezone = resolveTimezone(input);
    if (!isValidTimezone(timezone)) {
        return interaction.reply({
            content: '❌ I could not recognize that city. Try a city such as `Cairo`, `Dubai`, `London`, or `New York`, or enter an IANA timezone like `Africa/Cairo`.',
            flags: MessageFlags.Ephemeral
        });
    }

    await UserSettings.findOneAndUpdate(
        { userId: interaction.user.id },
        { $set: { timezone } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return interaction.reply({
        content: `✅ Your timezone is now set to \`${timezone}\`.`,
        flags: MessageFlags.Ephemeral
    });
}

if (interaction.isButton()) {
    if (interaction.customId === 'reset_favorites') {
        return interaction.update({
            content: '⚠️ Are you sure? This permanently deletes **all your saved anime and manga favorites** from MongoDB.',
            components: [buildResetConfirmation('favorites')]
        });
    }

    if (interaction.customId === 'reset_tracked') {
        if (!interaction.guildId) {
            return interaction.update({ content: '❌ Tracked items can only be reset inside a server.', components: [] });
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.update({ content: '❌ You need **Manage Channels** permission to reset server tracking.', components: [] });
        }
        return interaction.update({
            content: '⚠️ Are you sure? This permanently deletes **all tracked anime and manga in this server** from MongoDB.',
            components: [buildResetConfirmation('tracked')]
        });
    }

    if (interaction.customId === 'reset_cancel_favorites' || interaction.customId === 'reset_cancel_tracked') {
        return interaction.update({ content: '✅ Reset cancelled. No saved items were changed.', components: [] });
    }

    if (interaction.customId === 'reset_confirm_favorites') {
        await FavoriteItem.deleteMany({ userId: interaction.user.id });
        return interaction.update({ content: '🗑️ All your saved anime and manga favorites were permanently deleted from MongoDB.', components: [] });
    }

    if (interaction.customId === 'reset_confirm_tracked') {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.update({ content: '❌ You no longer have permission to reset this server tracking list.', components: [] });
        }
        await TrackedItem.deleteMany({ guildId: interaction.guildId });
        return interaction.update({ content: '🗑️ All tracked anime and manga were permanently deleted from MongoDB.', components: [] });
    }

    if (interaction.customId === 'start_settings') {
        return interaction.reply({
            content: '⚙️ Choose a setting to change:',
            components: [buildSettingsMenu()],
            flags: MessageFlags.Ephemeral
        });
    }

    if (interaction.customId === 'start_help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🤖 AniTracker Help')
            .setDescription('Use the commands below to search, track, and manage your anime library.')
            .addFields(
                { name: '🔎 Search', value: '`/anime` • `/manga` • `/character` • `/genre`', inline: false },
                { name: '📢 Tracking', value: '`/track` • `/untrack` • `/mytracked` • `/setup`', inline: false },
                { name: '⭐ Personal', value: '`/favorite` • `/myfavorites` • `/settings` • `/schedule`', inline: false },
                { name: '🧭 Start', value: '`/start` • `/help`', inline: false }
            )
            .setColor('#9b59b6');

        return interaction.reply({
            embeds: [helpEmbed],
            flags: MessageFlags.Ephemeral
        });
    }

    if (interaction.customId === 'schedule_change_timezone') {
        const modal = new ModalBuilder()
            .setCustomId('settings_timezone_modal')
            .setTitle('Change Your Timezone');
        const timezoneInput = new TextInputBuilder()
            .setCustomId('timezone')
            .setLabel('City or IANA timezone')
            .setPlaceholder('Cairo, Dubai, New York, or Africa/Cairo')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(timezoneInput));
        return interaction.showModal(modal);
    }

    if (interaction.customId.startsWith('settings_')) {
        const [, setting, , state] = interaction.customId.split('_');
        const enabled = state === 'on';

        if (setting === 'favorite') {
            await UserSettings.findOneAndUpdate(
                { userId: interaction.user.id },
                { $set: { favoriteDmsEnabled: enabled } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            return interaction.update({
                content: `✅ Favorite anime DM notifications are now **${enabled ? 'enabled' : 'disabled'}**.`,
                components: []
            });
        }

        if (setting === 'server') {
            if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.update({
                    content: '❌ You need **Manage Channels** permission to change server notifications.',
                    components: []
                });
            }
            await ServerSettings.findOneAndUpdate(
                { guildId: interaction.guildId },
                { $set: { serverAlertsEnabled: enabled } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            return interaction.update({
                content: `✅ Server episode alerts are now **${enabled ? 'enabled' : 'disabled'}**.`,
                components: []
            });
        }
    }

    if (interaction.customId.startsWith('more_info_')) {
        await interaction.deferReply({ ephemeral: true });
        await interaction.message.delete().catch(err => {
            console.warn('Could not delete media result message:', err.message);
        });
        const [, , mediaId, mediaType] = interaction.customId.split('_');
        if (!['anime', 'manga'].includes(mediaType) || !Number.isInteger(Number(mediaId))) {
            if (mediaType === 'manga' && /^[0-9a-f-]{36}$/i.test(mediaId)) {
                try {
                    const response = await axios.get(`https://api.mangadex.org/manga/${mediaId}`, {
                        params: { 'includes[]': 'cover_art' },
                        timeout: 10000
                    });
                    const item = response.data?.data;
                    const title = item?.attributes?.title?.en || Object.values(item?.attributes?.title || {})[0];
                    if (!item || !title) return interaction.editReply({ content: '❌ Manga information is currently unavailable.', ephemeral: true });
                    const description = item.attributes.description?.en || Object.values(item.attributes.description || {})[0] || 'No synopsis available.';
                    const details = new EmbedBuilder()
                        .setTitle(`📖 ${title}`)
                        .setURL(`https://mangadex.org/title/${mediaId}`)
                        .setDescription(cleanMediaDescription(description, 3800))
                        .addFields(
                            { name: 'Type', value: 'MANGADEX MANGA', inline: true },
                            { name: 'Status', value: item.attributes.status?.toUpperCase() || 'N/A', inline: true },
                            { name: 'Chapters', value: `${item.attributes.lastChapter || 'N/A'}`, inline: true },
                            { name: 'Volumes', value: `${item.attributes.lastVolume || 'N/A'}`, inline: true }
                        )
                        .setColor('#3498db')
                        .setFooter({ text: 'AniTracker • MangaDex REST API' });
                    return interaction.editReply({ embeds: [details], components: [] });
                } catch (err) {
                    console.error('MangaDex info button error:', err.message);
                    return interaction.editReply({ content: '❌ Failed to load manga information.', ephemeral: true });
                }
            }
            return interaction.editReply({ content: '❌ This media action is no longer valid. Please run the search again.', ephemeral: true });
        }
        const gqlQuery = `
        query ($id: Int, $type: MediaType) {
          Media (id: $id, type: $type) {
            id
            title { romaji english native }
            description(asHtml: false)
            genres
            studios { nodes { name } }
            format
            season
            seasonYear
            episodes
            chapters
            volumes
            status
            averageScore
            coverImage { large }
            siteUrl
            trailer { id site }
            characters(page: 1, perPage: 8, sort: FAVOURITES_DESC) {
              nodes {
                id
                name { full }
                image { large }
              }
            }
            relations {
              nodes {
                id
                type
                title { romaji english }
              }
            }
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, {
                id: Number(mediaId),
                type: mediaType === 'manga' ? 'MANGA' : 'ANIME'
            });
            const media = data?.Media;
            if (!media) {
                return interaction.editReply({ content: '❌ More information is currently unavailable.', ephemeral: true });
            }

            const title = media.title?.english || media.title?.romaji || 'Unknown title';
            const seasonText = media.season && media.seasonYear
                ? `${media.season.charAt(0).toUpperCase() + media.season.slice(1).toLowerCase()} ${media.seasonYear}`
                : (media.season ? media.season : 'N/A');
            const characterList = media.characters?.nodes?.map(character => character.name?.full).filter(Boolean).slice(0, 8).join(', ') || 'N/A';
            const relatedList = media.relations?.nodes?.filter(item => item.title?.english || item.title?.romaji)
                .slice(0, 5)
                .map(item => item.title?.english || item.title?.romaji)
                .join(', ') || 'N/A';

            const details = new EmbedBuilder()
                .setTitle(`📖 ${title}`)
                .setURL(media.siteUrl || 'https://anilist.co')
                .setThumbnail(media.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
                .setDescription(cleanMediaDescription(media.description, 3800))
                .addFields(
                    { name: 'Type', value: media.format || mediaType.toUpperCase(), inline: true },
                    { name: 'Status', value: media.status || 'N/A', inline: true },
                    { name: 'Score', value: media.averageScore ? `${media.averageScore} / 100` : 'N/A', inline: true },
                    { name: mediaType === 'manga' ? 'Chapters' : 'Episodes', value: `${mediaType === 'manga' ? (media.chapters ?? 'N/A') : (media.episodes ?? 'N/A')}`, inline: true },
                    { name: 'Season', value: seasonText, inline: true },
                    { name: 'Genres', value: media.genres?.slice(0, 8).join(', ') || 'N/A', inline: false },
                    { name: 'Main Characters', value: characterList, inline: false },
                    { name: 'Related / Seasons', value: relatedList, inline: false },
                    { name: 'Studios', value: media.studios?.nodes?.map(studio => studio.name).slice(0, 5).join(', ') || 'N/A', inline: false }
                )
                .setColor('#3498db')
                .setFooter({ text: 'AniTracker • More Info' });

            if (interaction.message) {
                const disabledButtons = buildMediaButtons(media, interaction, mediaType, true);
                await interaction.message.edit({ components: disabledButtons });
            }

            return interaction.editReply({
                embeds: [details],
                components: buildMediaButtons(media, interaction, mediaType, true)
            });
        } catch (err) {
            console.error('Media info button error:', err);
            return interaction.editReply({ content: '❌ Failed to load more information. Please try again later.', ephemeral: true });
        }
    }

    if (interaction.customId.startsWith('manga_track_btn_') || interaction.customId.startsWith('manga_fav_btn_')) {
        const isTrack = interaction.customId.startsWith('manga_track_btn_');
        if (isTrack && !interaction.guildId) {
            return interaction.reply({ content: '🎯 Manga channel tracking works inside a server.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const mangaId = interaction.customId.replace(isTrack ? 'manga_track_btn_' : 'manga_fav_btn_', '');

        try {
            let manga = await fetchMangaDexSearch(mangaId);
            if (!manga || manga.id !== mangaId) {
                const response = await axios.get(`https://api.mangadex.org/manga/${mangaId}`, {
                    params: { 'includes[]': 'cover_art' },
                    timeout: 10000
                });
                const item = response.data?.data;
                const title = item?.attributes?.title?.en || Object.values(item?.attributes?.title || {})[0];
                if (!item || !title) throw new Error('Manga not found');
                manga = { id: item.id, title, chapters: item.attributes.lastChapter || 0, status: item.attributes.status?.toUpperCase() || 'UNKNOWN', siteUrl: `https://mangadex.org/title/${item.id}`, source: 'mangadex' };
            }

            const existingQuery = isTrack
                ? { guildId: interaction.guildId, animeId: manga.id }
                : { userId: interaction.user.id, animeId: manga.id };
            const existing = isTrack
                ? await TrackedItem.findOne(existingQuery)
                : await findExistingFavorite(interaction.user.id, manga.id, manga.title);
            if (existing) {
                return interaction.editReply(`ℹ️ **${manga.title}** is already saved.`);
            }

            if (isTrack) {
                const latestChapter = await fetchMangaDexLatestChapter(manga.id).catch(() => Number(manga.chapters) || 0);
                await TrackedItem.create({
                    guildId: interaction.guildId,
                    channelId: await getServerAlertChannelId(interaction.guildId, interaction.channelId),
                    animeId: manga.id,
                    animeTitle: manga.title,
                    mediaType: 'manga',
                    lastEpisodes: latestChapter,
                    lastStatus: manga.status,
                    source: 'mangadex'
                });
                return interaction.editReply(`🎯 Successfully started tracking manga **[${manga.title}](${manga.siteUrl})**.`);
            }

            const latestChapter = await fetchMangaDexLatestChapter(manga.id).catch(() => Number(manga.chapters) || 0);
            await FavoriteItem.create({
                userId: interaction.user.id,
                animeId: manga.id,
                animeTitle: manga.title,
                mediaType: 'manga',
                lastEpisodes: latestChapter,
                source: 'mangadex'
            });
            return interaction.editReply(`⭐ Added manga **[${manga.title}](${manga.siteUrl})** to your personal favorites.`);
        } catch (err) {
            console.error('MangaDex save button error:', err.message);
            return interaction.editReply('❌ Could not save this manga right now. Please try again later.');
        }
    }

    if (interaction.customId.startsWith('track_btn_')) {
        if (!interaction.guildId) {
            return interaction.reply({
                content: '🎯 Channel tracking works inside a server. Use `/favorite <title>` for personal DM alerts.',
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });
        const animeId = parseInt(interaction.customId.replace('track_btn_', ''));
        if (!Number.isInteger(animeId)) {
            return interaction.editReply('❌ This tracking action is no longer valid. Please run the anime search again.');
        }

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
            await sendDevAlert(interaction, 'AniList unreachable during track operation.');
            return await interaction.editReply({ content: '❌ Could not connect to primary services to track this anime. Please try again in a moment.' });
        }

        if (anime.status === 'FINISHED' || anime.status === 'CANCELLED') {
            return await interaction.editReply({
                content: `ℹ️ **${anime.title?.english || anime.title?.romaji || 'This anime'}** is finished, so it cannot be tracked for new episodes.`
            });
        }

        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || 'Unknown Anime';
        const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: anime.id });

        if (existing) {
            return await interaction.editReply({ content: `**${animeTitle}** is already tracked in this server!` });
        }

        await TrackedItem.create({
            guildId: interaction.guildId,
            channelId: await getServerAlertChannelId(interaction.guildId, interaction.channelId),
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
        if (!Number.isInteger(animeId)) {
            return interaction.editReply('❌ This favorite action is no longer valid. Please run the anime search again.');
        }

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
            console.error('Fav Button AniList Error:', err.message);
        }

        if (!anime) {
            await sendDevAlert(interaction, 'AniList unreachable during favorite operation.');
            return await interaction.editReply({ content: '❌ Could not connect to primary services to save favorite. Please try again in a moment.' });
        }

        const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || 'Unknown Anime';

        if (anime.status === 'FINISHED') {
            return await interaction.editReply({
                content: `ℹ️ **${animeTitle}** is finished and cannot be added for new episode DM alerts.`
            });
        }

        const existing = await findExistingFavorite(interaction.user.id, anime.id, animeTitle);

        if (existing) {
            return await interaction.editReply({ content: `⭐ **${animeTitle}** is already in your personal favorites!` });
        }

        await FavoriteItem.create({
            userId: interaction.user.id,
            animeId: String(anime.id),
            animeTitle: animeTitle,
            lastEpisodes: anime.episodes || 0,
            source: 'anilist'
        });

        await interaction.editReply({ content: `⭐ Added **[${animeTitle}](${anime.siteUrl})** to your personal favorites! You will receive direct messages (DMs) when new episodes arrive.` });
    }
    else if (interaction.customId.startsWith('char_info_')) {
        await interaction.deferReply({ ephemeral: true });
        await interaction.message.delete().catch(err => {
            console.warn('Could not delete character result message:', err.message);
        });
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
            bloodType
            favourites
            siteUrl
            media (perPage: 10, sort: POPULARITY_DESC) {
              edges {
                node {
                  title { romaji english }
                }
                voiceActors {
                  name { full }
                  language
                  siteUrl
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
            await sendDevAlert(interaction, 'AniList unreachable during character info fetch.');
            return await interaction.editReply({ content: '❌ Character information is currently unavailable from primary services.' });
        }

        const altNames = char.name?.alternative?.filter(Boolean).join(', ') || 'N/A';
        const dob = char.dateOfBirth && (char.dateOfBirth.year || char.dateOfBirth.month || char.dateOfBirth.day)
            ? [char.dateOfBirth.year, char.dateOfBirth.month, char.dateOfBirth.day].filter(value => value != null).join('-')
            : 'N/A';

        let cleanDesc = char.description ? char.description
            .replace(/~!/g, '||')
            .replace(/!~/g, '||')
            .replace(/<[^>]*>/gm, '') : 'No description available.';
        if (cleanDesc.length > 4000) cleanDesc = cleanDesc.substring(0, 4000) + '...';

        const works = char.media?.edges
            ?.map(edge => {
                const title = edge.node?.title?.english || edge.node?.title?.romaji;
                if (!title) return null;
                const voiceActors = edge.voiceActors
                    ?.filter(actor => actor.name?.full)
                    .map(actor => `${actor.name.full}${actor.language ? ` (${actor.language})` : ''}`)
                    .join(', ');
                return `• ${title}${voiceActors ? ` — VA: ${voiceActors}` : ''}`;
            })
            .filter(Boolean)
            .join('\n') || 'N/A';

        const embed = new EmbedBuilder()
            .setTitle(`📖 ${char.name?.full || 'Unknown'} — More Info`)
            .setURL(char.siteUrl || 'https://anilist.co')
            .setDescription(cleanDesc)
            .setThumbnail(char.image?.large || 'https://i.imgur.com/AGv4yDI.png')
            .addFields(
                { name: 'Native Name', value: char.name?.native || 'N/A', inline: true },
                { name: 'Alternative Names', value: altNames.length > 1024 ? `${altNames.substring(0, 1021)}...` : altNames, inline: false },
                { name: 'Gender', value: char.gender || 'N/A', inline: true },
                { name: 'Age', value: char.age || 'N/A', inline: true },
                { name: 'Date of Birth', value: dob, inline: true },
                { name: 'Blood Type', value: char.bloodType || 'N/A', inline: true },
                { name: 'Favorites', value: `${char.favourites ? char.favourites.toLocaleString() : 0}`, inline: true },
                { name: 'Works and Voice Actors', value: works.length > 1024 ? `${works.substring(0, 1021)}...` : works, inline: false }
            )
            .setColor('#9b59b6')
            .setFooter({ text: 'AniTracker • Character details from AniList' });

        await interaction.editReply({ embeds: [embed] });
    }
    return;
    }

    if (interaction.isAutocomplete()) {
        const focused = String(interaction.options.getFocused() || '').trim();
        const autocompleteCommands = new Set(['anime', 'manga', 'character', 'track', 'favorite', 'fav']);
        if (!autocompleteCommands.has(interaction.commandName) || focused.length < 1) {
            return interaction.respond([]);
        }

        if (interaction.commandName === 'character') {
            const query = `
            query ($search: String) {
              Page (page: 1, perPage: 8) {
                characters (search: $search, sort: SEARCH_MATCH) {
                  id
                  name { full native }
                }
              }
            }`;
            try {
                const data = await fetchAniList(query, { search: focused });
                const choices = (data?.Page?.characters || [])
                    .map(character => {
                        const title = character.name?.full || character.name?.native || focused;
                        return {
                            name: `${title} (${character.id})`.substring(0, 100),
                            value: title.substring(0, 100)
                        };
                    });
                return interaction.respond(choices);
            } catch (err) {
                console.error('Character autocomplete error:', err.message);
                return interaction.respond([]);
            }
        }

        const requestedMedia = interaction.options.getString('media');
        if (interaction.commandName === 'manga' || (interaction.commandName === 'favorite' && requestedMedia === 'manga')) {
            try {
                const response = await axios.get('https://api.mangadex.org/manga', {
                    params: { title: focused, limit: 8 },
                    timeout: 8000
                });
                const choices = (response.data?.data || []).map(item => {
                    const title = item.attributes?.title?.en
                        || Object.values(item.attributes?.title || {})[0]
                        || focused;
                    return { name: title.substring(0, 100), value: title.substring(0, 100) };
                });
                return interaction.respond(choices);
            } catch (err) {
                console.error('MangaDex autocomplete error:', err.message);
                return interaction.respond([]);
            }
        }

        const mediaType = interaction.commandName === 'manga' ? 'MANGA' : 'ANIME';
        const query = `
        query ($search: String) {
          Page (page: 1, perPage: 8) {
            media (search: $search, type: ${mediaType}, sort: SEARCH_MATCH) {
              id
              title { romaji english }
            }
          }
        }`;
        try {
            const data = await fetchAniList(query, { search: focused });
            const choices = (data?.Page?.media || []).map(media => ({
                name: `${media.title?.english || media.title?.romaji || 'Unknown'} (${media.id})`.substring(0, 100),
                value: (media.title?.english || media.title?.romaji || focused).substring(0, 100)
            }));
            return interaction.respond(choices);
        } catch (err) {
            console.error(`${interaction.commandName} autocomplete error:`, err);
            return interaction.respond([]);
        }
    }

    if (!interaction.isChatInputCommand()) return;

    const commandName = interaction.commandName === 'fav'
        ? 'favorite'
        : interaction.commandName;

    // -------------------------------------------------------------
// 🚀 Start Command
// -------------------------------------------------------------
if (commandName === 'start') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder()
        .setTitle('🚀 Welcome to AniTracker')
        .setDescription('Search anime and manga, keep track of weekly releases, save favorites, and get alerts without leaving Discord.')
        .addFields(
            { name: '🔎 Discover', value: '`/anime` • `/manga` • `/character` • `/genre`', inline: false },
            { name: '📢 Tracking', value: '`/track` • `/untrack` • `/mytracked` • `/setup`', inline: false },
            { name: '⭐ Personal', value: '`/favorite` • `/myfavorites` • `/schedule` • `/settings`', inline: false },
            { name: '💡 Quick Start', value: 'Run `/anime <title>` or `/manga <title>`, then use the buttons for more info, share, and alerts.', inline: false }
        )
        .setColor('#2ecc71')
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({ text: 'AniTracker • Ready to explore' });

    const supportBtn = new ButtonBuilder()
        .setLabel('💬 Support Server')
        .setStyle(ButtonStyle.Link)
        .setURL('https://discord.gg/H4Af2y4RD8');

    const inviteBtn = new ButtonBuilder()
        .setLabel('➕ Add Bot')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=8`);

    const helpBtn = new ButtonBuilder()
        .setLabel('📖 Help')
        .setStyle(ButtonStyle.Secondary)
        .setCustomId('start_help');

    const settingsBtn = new ButtonBuilder()
        .setCustomId('start_settings')
        .setLabel('⚙️ Settings')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(supportBtn, inviteBtn, helpBtn, settingsBtn);

    if (!interaction.guildId) {
        return interaction.editReply({ embeds: [embed], components: [row] });
    }

    try {
        await interaction.user.send({ embeds: [embed], components: [row] });
        await interaction.editReply({
            content: '📥 I sent the setup guide to your DMs.'
        });
    } catch (error) {
        if (error.code === 50007) {
            await interaction.editReply({
                content: '⚠️ I could not send a DM. Please allow DMs and try again.',
                embeds: [embed],
                components: [row]
            });
        } else {
            console.error('Failed to send start DM:', error);
            await interaction.editReply({
                content: '❌ Something went wrong while opening the guide.',
                embeds: [embed],
                components: [row]
            });
        }
    }
}

// 🔞 Show the current user's manual age-verification status
else if (commandName === 'verification-status') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const verification = await AgeVerification.findOne({ userId: interaction.user.id }).lean();

        if (!verification) {
            return interaction.editReply({
                content: '🔒 **Not verified for 18+ content.**\n\nAge verification must be approved manually by the bot owner. Join the support server to request a review:\nhttps://discord.gg/H4Af2y4RD8'
            });
        }

        const verifiedAt = verification.verifiedAt
            ? `<t:${Math.floor(new Date(verification.verifiedAt).getTime() / 1000)}:F>`
            : 'an earlier date';

        return interaction.editReply({
            content: `✅ **You are verified for 18+ content.**\nApproved ${verifiedAt}.\n\nIf your access should be removed, contact the bot owner.`
        });
    } catch (err) {
        console.error('verification-status command error:', err);
        return interaction.editReply({
            content: '❌ I could not check your verification status right now. Please try again later.'
        });
    }
}

   // 🔞 Owner-controlled age verification (Approve)
else if (commandName === 'verify') {
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
        const existingVerification = await AgeVerification.findOne({ userId: user.id });
        if (existingVerification) {
            return interaction.editReply({
                content: `ℹ️ **${user.tag}** is already age-verified.\nApproved ${existingVerification.verifiedAt ? `<t:${Math.floor(new Date(existingVerification.verifiedAt).getTime() / 1000)}:F>` : 'previously'}.\nNo changes were made.`
            });
        }

        // 2. Save the owner's approval
        await AgeVerification.updateOne(
            { userId: user.id },
            { $set: { userId: user.id, verifiedAt: new Date(), verifiedBy: interaction.user.id } },
            { upsert: true }
        );

        // 3. DM Notification
        let dmSent = true;
        try {
            await user.send(`🎉 **Age Verification Approved!**\nYour account has been manually verified by the bot owner. You can now access 18+ anime, manga, and genre recommendations.\nUse \`/verification-status\` any time to check your status.`);
        } catch (dmErr) {
            dmSent = false;
        }

        // 4. Response back to Owner
        const dmStatusText = dmSent ? '📬 DM notification sent.' : '⚠️ Could not send DM (User DMs are disabled).';
        
        await interaction.editReply({
            content: `✅ **${user.tag}** is now approved for 18+ content.\nThey can check their status with \`/verification-status\`.\n${dmStatusText}`
        });

    } catch (err) {
        console.error('verify command error:', err);
        await interaction.editReply({ 
            content: '❌ Could not save the age verification in database. Please check console logs.' 
        });
    }
}
        
    // 🚫 Owner-controlled age unverification (Remove)
else if (commandName === 'unverify') {
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
            await user.send(`🔒 **Age Verification Removed.**\nYour 18+ access has been revoked by the bot owner. Adult anime, manga, and genre recommendations are locked again.`);
        } catch (dmErr) {
            dmSent = false;
        }

        // 5. Response back to Owner
        const dmStatusText = dmSent ? '📬 DM notification sent.' : '⚠️ Could not send DM (User DMs are disabled).';
        
        await interaction.editReply({
            content: `🗑️ Age verification removed for **${user.tag}**. 18+ AniList recommendations are now locked for this user.\n${dmStatusText}`
        });

    } catch (err) {
        console.error('unverify command error:', err);
        await interaction.editReply({ 
            content: '❌ Could not remove age verification. Please try again later.' 
        });
    }
}
// 📅 Today's Anime Schedule Command
else if (commandName === 'settings') {
    await interaction.reply({
        content: '⚙️ Choose a setting to change:',
        components: [buildSettingsMenu()],
        flags: MessageFlags.Ephemeral
    });
}
// 📅 Today's Anime Schedule Command
else if (commandName === 'setup') {
    if (!interaction.guildId) {
        return interaction.reply({
            content: '❌ `/setup` can only be used inside a server.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        if (!canRunServerSetup(interaction)) {
            return interaction.reply({
                content: '❌ Only the server owner, an administrator, or the bot owner can run `/setup`.',
                flags: MessageFlags.Ephemeral
            });
        }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const botMember = await interaction.guild.members.fetch(client.user.id);
        const rolePermissions = [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory
        ];
        let botRole = interaction.guild.roles.cache.find(role => role.name === 'AniTracker Alerts' && !role.managed);

        if (!botRole) {
            botRole = await interaction.guild.roles.create({
                name: 'AniTracker Alerts',
                permissions: rolePermissions,
                reason: 'AniTracker server setup'
            });
        } else {
            await botRole.setPermissions(rolePermissions, 'AniTracker server setup');
        }

        await botMember.roles.add(botRole, 'AniTracker server setup');
        await ServerSettings.findOneAndUpdate(
            { guildId: interaction.guildId },
            { $set: { botRoleId: botRole.id } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        await interaction.editReply({
            content: `✅ The **${botRole.name}** role is ready and assigned to me.\n\nNow choose the channel where tracking and episode alerts should be sent:`,
            components: [buildSetupChannelMenu()]
        });
    } catch (err) {
        console.error('Setup role error:', err);
        await interaction.editReply({
            content: '❌ I could not create or assign the AniTracker role. Make sure I have **Manage Roles** and that my highest role is above the AniTracker Alerts role.'
        });
    }
}
// 📅 Today's Anime Schedule Command
else if (commandName === 'schedule') {
    await interaction.deferReply();

    try {
        const userSettings = await UserSettings.findOne({ userId: interaction.user.id }).lean();
        const timezone = userSettings?.timezone || 'UTC';
        // 1️⃣ حساب بداية ونهاية اليوم بتوقيت UTC
        const now = new Date();
        const startOfDay = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) / 1000);
        const endOfDay = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59) / 1000);

        const gqlQuery = `
        query ($start: Int, $end: Int) {
          Page(perPage: 50) {
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
        let sourceName = 'AniList';

        // 2️⃣ المحاولة الأولى: AniList API
        try {
            const data = await fetchAniList(gqlQuery, { start: startOfDay, end: endOfDay });
            schedules = (data?.Page?.airingSchedules || []).map(item => ({
                episode: item.episode,
                airingAt: item.airingAt,
                title: item.media?.title?.english || item.media?.title?.romaji || 'Unknown Anime'
            }));
        } catch (aniListErr) {
            console.warn('AniList failed for schedule, switching to Jikan (MAL) Fallback:', aniListErr.message);
        }

        // 3️⃣ المحاولة الثانية (Fallback): Jikan API (MyAnimeList)
        if (schedules.length === 0) {
            sourceName = 'MyAnimeList';
            try {
                const dayName = now.toLocaleDateString('en-US', { weekday: 'lowercase', timeZone: 'UTC' });
                const jikanRes = await fetch(`https://api.jikan.moe/v4/schedules?filter=${dayName}`)
                    .then(res => res.json())
                    .catch(() => null);

                if (jikanRes?.data) {
                    schedules = jikanRes.data.map(item => ({
                        episode: item.episodes || 'New',
                        // استخدام وقت الصدور الحالي كـ Timestamp تقريبي لو مش متاح
                        airingAt: item.aired?.from ? Math.floor(new Date(item.aired.from).getTime() / 1000) : Math.floor(Date.now() / 1000),
                        title: item.title_english || item.title
                    }));
                }
            } catch (jikanErr) {
                console.error('Jikan Fallback failed:', jikanErr.message);
            }
        }

        // لو مفيش بيانات من المصدرين
        if (schedules.length === 0) {
            return await interaction.editReply('📅 No new anime episodes scheduled for today!');
        }

        // 4️⃣ تنسيق القائمة والقطع الذكي لمنع تخريب الـ Markdown
        let descriptionLines = [];
        for (const item of schedules) {
            const timeString = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                timeStyle: 'short'
            }).format(new Date(item.airingAt * 1000));
            const line = `• **Ep ${item.episode}** - **${item.title}** at ${timeString}`;
            
            // تحقق إن إجمالي الحروف متعداش 3800 حرف قبل الإضافة
            const currentTotalLength = descriptionLines.join('\n').length;
            if (currentTotalLength + line.length > 3800) {
                descriptionLines.push('\n*...and more episodes today.*');
                break;
            }
            descriptionLines.push(line);
        }

        const embed = new EmbedBuilder()
            .setColor('#ff69b4')
            .setTitle('📅 Today\'s Anime Schedule')
            .setDescription(`${descriptionLines.join('\n')}\n\n💡 Want to change the time shown here? Click **Change timezone** below, or use \`/settings\` anytime.`)
            .setFooter({ text: `Total scheduled: ${schedules.length} • Powered by ${sourceName} • Your timezone: ${timezone}` })
            .setTimestamp();

        const timezoneButton = new ButtonBuilder()
            .setCustomId('schedule_change_timezone')
            .setLabel('Change timezone')
            .setStyle(ButtonStyle.Primary);
        await interaction.editReply({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(timezoneButton)]
        });

    } catch (err) {
        console.error('Error fetching schedule:', err);
        await interaction.editReply('❌ An error occurred while fetching today\'s schedule. Please try again later!');
    }
}
        // 🎭 Character Search Command
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
        media (perPage: 5, sort: POPULARITY_DESC) {
          edges {
            voiceActors (language: JAPANESE) {
              name { full }
              siteUrl
            }
            node {
              title { romaji english }
            }
          }
        }
      }
    }`;

    let char = null;

    // 1️⃣ المحاولة الأولى: AniList API
    try {
        const data = await fetchAniList(gqlQuery, { search: characterName });
        char = data?.Character;
    } catch (err) {
        console.error('Character AniList Fetch Error:', err.message);
    }

    // 2️⃣ المحاولة الثانية (Emergency Backup - Jikan API)
    if (!char) {
        console.log(`AniList failed or returned no character for [${characterName}]. Attempting Backup...`);
        try {
            const jikanRes = await fetch(`https://api.jikan.moe/v4/characters?q=${encodeURIComponent(characterName)}&limit=1`);
            if (!jikanRes.ok) {
                throw new Error(`Jikan responded with ${jikanRes.status}`);
            }
            const jikanData = await jikanRes.json();
            const jikanChar = jikanData?.data?.[0];

            if (jikanChar) {
                // تنظيف الوصف الذكي مع حماية الـ Markdown
                let rawDesc = jikanChar.about || 'No description available.';
                rawDesc = rawDesc.replace(/<[^>]*>/gm, '').replace(/~!/g, '||').replace(/!~/g, '||');

                let cleanDesc = rawDesc.length > 350 ? rawDesc.substring(0, 350) + '...' : rawDesc;
                // إغلاق الـ Spoiler لو اتطبق ونقطع في وسطه
                if ((cleanDesc.match(/\|\|/g) || []).length % 2 !== 0) cleanDesc += '||';

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

                // تنبيه المطور عبر الـ DM بدلاً من الـ FollowUp العلني
                await sendDevAlert(interaction, `AniList character lookup failed for **"${characterName}"**. Used Emergency Backup (Jikan).`);

                return;
            }
        } catch (backupErr) {
            console.error('Character Backup Fetch Error:', backupErr);
        }

        // 3️⃣ Final fallback (Kitsu API)
        try {
            const kitsuChar = await getCharacterJikan(characterName);
            if (kitsuChar) {
                const embed = new EmbedBuilder()
                    .setTitle(`🎭 ${kitsuChar.name || characterName}`)
                    .setURL(kitsuChar.url || 'https://kitsu.io')
                    .setDescription('Click **More Info** for the full biography and character details.')
                    .setImage(kitsuChar.image || 'https://i.imgur.com/AGv4yDI.png')
                    .setColor('#9b59b6')
                    .setFooter({ text: 'AniTracker • Character Search (Kitsu Backup)' });

                const pinterestLink = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent((kitsuChar.name || characterName) + ' anime fanart')}`;
                const animeFanartBtn = new ButtonBuilder()
                    .setLabel('🎨 Fanart')
                    .setStyle(ButtonStyle.Link)
                    .setURL(pinterestLink);

                await interaction.editReply({
                    embeds: [embed],
                    components: [new ActionRowBuilder().addComponents(animeFanartBtn)]
                });
                return;
            }
        } catch (kitsuErr) {
            console.error('Character Kitsu fallback error:', kitsuErr.message);
        }

        return await interaction.editReply(`❌ Sorry, no character found with the name **"${characterName}"** on AniList or Emergency Backup.`);
    }

    // 3️⃣ عرض بيانات AniList الأصلي
    try {
        const nameFull = char.name?.full || characterName;
        const nameNative = char.name?.native ? ` (${char.name.native})` : '';
        
        // استخراج أول انمي ومؤدي الصوت الياباني
        const firstEdge = char.media?.edges?.[0];
        const animeSource = firstEdge?.node?.title?.english || firstEdge?.node?.title?.romaji || 'Unknown Anime';
        const vaName = firstEdge?.voiceActors?.[0]?.name?.full || 'N/A';

        // تنظيف الوصف وإغلاق الـ Spoilers المقطوعة
        let rawDesc = char.description || 'No description available.';
        rawDesc = rawDesc.replace(/<[^>]*>/gm, '').replace(/~!/g, '||').replace(/!~/g, '||');

        const embed = new EmbedBuilder()
            .setTitle(`🎭 ${nameFull}${nameNative}`)
            .setURL(char.siteUrl || 'https://anilist.co')
            .setDescription('Click **More Info** for the full biography and character details.')
            .addFields(
                { name: '📺 From Anime', value: animeSource, inline: true },
                { name: '🎙️ Voice Actor', value: vaName, inline: true },
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
        await interaction.editReply('❌ Failed to fetch character data.');
    }
}
   // ⭐ Favorite Command (With Emergency Fallback & Dev Alert)
else if (commandName === 'favorite') {
    await interaction.deferReply({ ephemeral: true });
    const searchQuery = interaction.options.getString('title');
    const requestedMedia = interaction.options.getString('media') || 'anime';

    if (requestedMedia === 'manga') {
        try {
            const manga = await fetchMangaDexSearch(searchQuery);
            if (!manga) return interaction.editReply(`❌ No manga found for **"${searchQuery}"** on MangaDex.`);
            const existing = await findExistingFavorite(interaction.user.id, manga.id, manga.title);
            if (existing) return interaction.editReply(`⭐ **${manga.title}** is already in your personal favorites!`);
            const latestChapter = await fetchMangaDexLatestChapter(manga.id).catch(() => Number(manga.chapters) || 0);
            await FavoriteItem.create({
                userId: interaction.user.id,
                animeId: manga.id,
                animeTitle: manga.title,
                mediaType: 'manga',
                lastEpisodes: latestChapter,
                source: 'mangadex'
            });
            return interaction.editReply(`⭐ Added manga **[${manga.title}](${manga.siteUrl})** to your personal favorites.`);
        } catch (err) {
            console.error('Favorite MangaDex command error:', err.message);
            return interaction.editReply('❌ MangaDex is temporarily unavailable. Please try again later.');
        }
    }

    const gqlQuery = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title { romaji english }
        episodes
        status
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
                const kitsuId = `kitsu_${kitsuAnime.id}`;
                const animeTitle = attr.canonicalTitle || attr.titles?.en || searchQuery;
                const siteUrl = `https://kitsu.io/anime/${kitsuAnime.id}`;

                const existing = await findExistingFavorite(interaction.user.id, kitsuId, animeTitle);

                if (existing) {
                    return await interaction.editReply(`⭐ **${animeTitle}** is already in your personal favorites!`);
                }

                await FavoriteItem.create({
                    userId: interaction.user.id,
                    animeId: kitsuId,
                    animeTitle: animeTitle,
                    lastEpisodes: attr.episodeCount || 0,
                    source: 'kitsu'
                });

                await interaction.editReply(`⭐ Added **[${animeTitle}](${siteUrl})** to your personal favorites! You will receive DMs when new episodes drop.`);

                // Dev Alert
                await sendDevAlert(interaction, 'AniList was unreachable for `/favorite`. Processed via Emergency Backup (Kitsu).');

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

        if (anime.status === 'FINISHED') {
            return await interaction.editReply(`ℹ️ **${animeTitle}** is finished and cannot be added for new episode DM alerts.`);
        }

        const existing = await findExistingFavorite(interaction.user.id, anime.id, animeTitle);

        if (existing) {
            return await interaction.editReply(`⭐ **${animeTitle}** is already in your personal favorites!`);
        }

        await FavoriteItem.create({
            userId: interaction.user.id,
            animeId: String(anime.id),
            animeTitle: animeTitle,
            lastEpisodes: anime.episodes || 0,
            source: 'anilist'
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
                const kitsuId = `kitsu_${kitsuAnime.id}`;
                const animeTitle = kitsuAnime.attributes?.canonicalTitle || searchQuery;

                const deleted = await FavoriteItem.findOneAndDelete({ userId: interaction.user.id, animeId: kitsuId });

                if (deleted) {
                    // Dev Alert
                    await sendDevAlert(interaction, 'AniList was unreachable for `/unfavorite`. Processed via Emergency Backup (Kitsu).');
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
        const deleted = await FavoriteItem.findOneAndDelete({ userId: interaction.user.id, animeId: String(anime.id) });

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
    // استخدام الطريقة الحديثة لـ Ephemeral في Discord.js v14
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // 1️⃣ استعلام سريع وخفيف من Mongoose باستخدام select و lean
        const favorites = await FavoriteItem.find({ userId: interaction.user.id })
            .select('animeTitle mediaType')
            .lean();

        if (!favorites || favorites.length === 0) {
           return await interaction.editReply({
               content: '⭐ You currently have no saved anime or manga favorites.\nUse `/favorite <title>` to add an anime or manga!'
           });
        }

        await interaction.editReply({
           content: '⭐ Choose a saved anime or manga to view its details:',
            components: buildSavedMediaComponents(
               'myfavorites_type_select',
                favorites,
                'Choose a saved anime or manga',
                'favorites'
            )
        });

    } catch (err) {
        console.error('MyFavorites command error:', err);
        await interaction.editReply({
            content: '❌ Failed to fetch your personal favorites list. Please try again later!'
        });
    }
}
    // 📖 Help Command
else if (commandName === 'help') {
    const canSeeSetup = interaction.guildId && canRunServerSetup(interaction);
    const embed = new EmbedBuilder()
        .setTitle('🤖 AniTracker Command Center')
        .setDescription('Search, track, and manage your anime and manga experience from Discord.')
        .addFields(
            {
                name: '🔎 Discover',
                value: '`/anime` • Search anime\n`/manga` • Search manga\n`/character` • Search characters\n`/genre` • Recommendations by category\n`/schedule` • Daily release schedule'
            },
            {
                name: '⭐ Personal',
                value: '`/favorite` • Save anime or manga for DM alerts\n`/unfavorite` • Remove a favorite\n`/myfavorites` • View and reset your saved list\n`/verification-status` • Check 18+ access\n`/settings` • Timezone and notification preferences'
            },
            {
                name: '📢 Server Tools',
                value: '`/track` • Track anime or manga alerts\n`/untrack` • Stop tracking\n`/mytracked` • View and reset tracked titles\n`/setup` • Setup the alert channel'
            },
            {
                name: '🧭 Start Here',
                value: '`/start` • Welcome guide\n`/help` • This command list'
            }
        )
        .setColor('#9b59b6')
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({ text: 'AniTracker • Everything you need to get started' })
        .setTimestamp();

    const supportBtn = new ButtonBuilder()
        .setLabel('💬 Support Server')
        .setStyle(ButtonStyle.Link)
        .setURL('https://discord.gg/H4Af2y4RD8');

    const settingsBtn = new ButtonBuilder()
        .setCustomId('start_settings')
        .setLabel('⚙️ Settings')
        .setStyle(ButtonStyle.Secondary);

    const profileBtn = new ButtonBuilder()
        .setLabel('👤 Developer Profile')
        .setStyle(ButtonStyle.Link)
        .setURL('https://discord.com/users/1326815636395003966');

    const row = new ActionRowBuilder().addComponents(supportBtn, settingsBtn, profileBtn);

    await interaction.reply({
        embeds: [embed],
        components: [row],
        flags: MessageFlags.Ephemeral
    });
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
        trailer { id site }
        isAdult
      }
    }`;

    let anime = null;

    // 1️⃣ المحاولة الأولى: AniList API
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        anime = data?.Media;
    } catch (err) {
        console.error('AniList Fetch Error:', err.message);
    }

    // 2️⃣ المحاولة الثانية (Emergency Backup) إذا فشل AniList
    if (!anime) {
        console.log('AniList failed or returned no data. Fetching from Fallback...');
        try {
            const jikanData = await getAnimeJikan(searchQuery);

            if (jikanData) {
                // تنظيف الوصف بشكل ذكي
                let rawSynopsis = jikanData.synopsis || 'No synopsis available.';
                rawSynopsis = rawSynopsis.replace(/<[^>]*>?/gm, '');
                const cleanSynopsis = rawSynopsis.length > 320 
                    ? rawSynopsis.substring(0, 320).trim() + '...' 
                    : rawSynopsis;

                const fallbackEmbed = new EmbedBuilder()
                    .setTitle(jikanData.title)
                    .setURL(jikanData.url || 'https://myanimelist.net')
                    .setThumbnail(jikanData.image || 'https://i.imgur.com/AGv4yDI.png')
                    .addFields(
                        { name: 'Episodes', value: `${jikanData.episodes ?? 'N/A'}`, inline: true },
                        { name: 'Status', value: jikanData.status || 'N/A', inline: true },
                        { name: 'Score', value: jikanData.score ? `${jikanData.score}` : 'N/A', inline: true }
                    )
                    .setDescription('Click **Share** for the source page. Full synopsis is available on the linked page.')
                    .setColor('#FF5733')
                    .setFooter({ text: 'AniTracker • Search (Backup API)' });

                // 🎯 الأزرار للانميات المستمرة
                let fallbackComponents = [];
                const currentStatus = (jikanData.status || '').toUpperCase();
                const isOngoing = currentStatus.includes('RELEASING') || currentStatus.includes('CURRENT') || currentStatus.includes('AIRING');

                if (isOngoing && Number.isInteger(Number(jikanData.id))) {
                    const animeIdentifier = Number(jikanData.id);

                    const fallbackFavBtn = new ButtonBuilder()
                        .setCustomId(`fav_btn_${animeIdentifier}`)
                        .setLabel('⭐ Favorite (DM Alert)')
                        .setStyle(ButtonStyle.Primary);

                    const fallbackButtons = [fallbackFavBtn];

                    if (interaction.guildId) {
                        const fallbackTrackBtn = new ButtonBuilder()
                            .setCustomId(`track_btn_${animeIdentifier}`)
                            .setLabel('🎯 Channel Track')
                            .setStyle(ButtonStyle.Success);
                        fallbackButtons.unshift(fallbackTrackBtn);
                    }

                    fallbackComponents = [new ActionRowBuilder().addComponents(...fallbackButtons)];
                }

                await interaction.editReply({ embeds: [fallbackEmbed], components: fallbackComponents });

                // تنبيه المطور عبر الـ DM بدلاً من الـ FollowUp
                await sendDevAlert(interaction, `AniList was unreachable for **"${searchQuery}"**. Fetched via Emergency Backup.`);

                return;
            }
        } catch (fallbackErr) {
            console.error('Fallback Error:', fallbackErr);
        }

        return await interaction.editReply(`❌ Sorry, no anime found matching **"${searchQuery}"** on AniList or Emergency Backup.`);
    }

    // 3️⃣ عرض بيانات AniList الرئيسية
    try {
        // التحقق من المحتوى المخصص للكبار (18+)
        if (anime.isAdult) {
            let isVerified = false;

            try {
                isVerified = Boolean(await AgeVerification.exists({ userId: interaction.user.id }));
            } catch (err) {
                console.error('Age verification lookup error:', err);
            }

            if (!isVerified) {
                return interaction.editReply({
                    content: `🔞 **This anime contains adult content (18+).**\n\n` +
                             `⚠️ Access requires manual approval from the bot owner. Join the support server to request verification:\n` +
                             `https://discord.gg/H4Af2y4RD8`,
                    embeds: [],
                    components: []
                });
            }
        }

        const title = anime.title?.english || anime.title?.romaji || searchQuery;
        
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setURL(anime.siteUrl || 'https://anilist.co')
            .setThumbnail(anime.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
            .addFields(
                { name: 'Episodes', value: `${anime.episodes ?? 'N/A'}`, inline: true },
                { name: 'Status', value: anime.status || 'N/A', inline: true },
                { name: 'Score', value: anime.averageScore ? `${anime.averageScore} / 100` : 'N/A', inline: true }
            )
            .setDescription('Click **More Info** for the full synopsis and details.')
            .setColor('#FF5733')
            .setFooter({ text: 'AniTracker • Anime Search' });

        const components = buildMediaButtons(anime, interaction, 'anime');

        await interaction.editReply({ 
            embeds: [embed], 
            components: components 
        });
    } catch (err) {
        console.error('Anime Command Render Error:', err);
        await interaction.editReply('❌ Failed to display anime data. Please try again!');
    }
}
    // 🌐 Dev-Only Server List Command
else if (commandName === 'servers') {
    // 1️⃣ التحقق من هوية المطور
    const DEV_ID = '1326815636395003966';
    if (interaction.user.id !== DEV_ID) {
        return interaction.reply({ 
            content: '❌ This command is restricted to the bot developer only!', 
            flags: 64 
        });
    }

    await interaction.deferReply({ flags: 64 });

    try {
        // 2️⃣ ترتيب السيرفرات من الأكبر للأصغر حسب عدد الأعضاء
        const sortedGuilds = Array.from(interaction.client.guilds.cache.values())
            .sort((a, b) => b.memberCount - a.memberCount);

        const totalGuilds = sortedGuilds.length;
        const totalMembers = sortedGuilds.reduce((acc, g) => acc + g.memberCount, 0);

        // 3️⃣ تجميع الأسطر مع القطع الذكي لمنع تجاوز حد ديسكورد
        let descriptionLines = [];
        for (let i = 0; i < sortedGuilds.length; i++) {
            const g = sortedGuilds[i];
            const line = `${i + 1}. **${g.name}** (\`${g.id}\`) - **${g.memberCount.toLocaleString()}** members`;
            
            const currentTotalLength = descriptionLines.join('\n').length;
            if (currentTotalLength + line.length > 3800) {
                descriptionLines.push(`\n*...and ${totalGuilds - i} more servers.*`);
                break;
            }
            descriptionLines.push(line);
        }

        const embed = new EmbedBuilder()
            .setTitle(`🌐 Connected Servers (${totalGuilds.toLocaleString()})`)
            .setDescription(descriptionLines.join('\n'))
            .setColor('#3498db')
            .addFields(
                { name: '👥 Total Users Reached', value: `\`${totalMembers.toLocaleString()}\` members`, inline: true },
                { name: '📊 Server Count', value: `\`${totalGuilds.toLocaleString()}\` servers`, inline: true }
            )
            .setFooter({ text: 'AniTracker • Developer Admin Panel' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (err) {
        console.error('Servers command error:', err);
        await interaction.editReply('❌ Failed to fetch server list.');
    }
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

    try {
        const manga = await fetchMangaDexSearch(searchQuery);
        if (!manga) {
            return interaction.editReply(`❌ Sorry, no manga found matching **"${searchQuery}"** on MangaDex.`);
        }

        const embed = new EmbedBuilder()
            .setTitle(manga.title)
            .setURL(manga.siteUrl)
            .setThumbnail(manga.image)
            .setDescription(`${cleanMediaDescription(manga.description, 320)}\n\nClick "More Info" for more details.`)
            .addFields(
                { name: 'Chapters', value: `${manga.chapters || 'N/A'}`, inline: true },
                { name: 'Volumes', value: `${manga.volumes || 'N/A'}`, inline: true },
                { name: 'Status', value: manga.status, inline: true }
            )
            .setColor('#33FF57')
            .setFooter({ text: 'AniTracker • MangaDex REST API' });

        return interaction.editReply({
            embeds: [embed],
            components: buildMediaButtons(manga, interaction, 'manga')
        });
    } catch (err) {
        console.error('MangaDex search error:', err.message);
        return interaction.editReply('❌ MangaDex is temporarily unavailable. Please try again later.');
    }

    const gqlQuery = `
    query ($search: String) {
      Media (search: $search, type: MANGA) {
        id
        title { romaji english }
        chapters
        volumes
        status
        averageScore
        description(asHtml: false)
        coverImage { large }
        siteUrl
        genres
        isAdult
      }
    }`;

    let manga = null;

    // 1️⃣ المحاولة الأولى: AniList API
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        manga = data?.Media;
    } catch (err) {
        console.error('AniList Manga Fetch Error:', err.message);
    }

    // 2️⃣ المحاولة الثانية (Emergency Backup) إذا فشل AniList
    if (!manga) {
        console.log('AniList failed or returned no data for Manga. Fetching from Fallback...');
        try {
            const jikanData = await getMangaJikan(searchQuery);

            if (jikanData) {
                // تنظيف الوصف بشكل آمن
                let rawSynopsis = jikanData.synopsis || 'No synopsis available.';
                rawSynopsis = rawSynopsis.replace(/<[^>]*>?/gm, '');
                const cleanSynopsis = rawSynopsis.length > 320 
                    ? rawSynopsis.substring(0, 320).trim() + '...' 
                    : rawSynopsis;

                const fallbackEmbed = new EmbedBuilder()
                    .setTitle(jikanData.title)
                    .setURL(jikanData.url || 'https://myanimelist.net')
                    .setThumbnail(jikanData.image || 'https://i.imgur.com/AGv4yDI.png')
                    .addFields(
                        { name: 'Chapters', value: `${jikanData.chapters ?? jikanData.episodes ?? 'N/A'}`, inline: true },
                        { name: 'Status', value: jikanData.status || 'N/A', inline: true },
                        { name: 'Score', value: jikanData.score ? `${jikanData.score}` : 'N/A', inline: true }
                    )
                    .setDescription('Click "More Info" for more details.')
                    .setColor('#33FF57')
                    .setFooter({ text: 'AniTracker • Manga Search (Backup API)' });

                await interaction.editReply({ embeds: [fallbackEmbed], components: [] });

                // تنبيه المطور عبر الـ DM بدلاً من الـ FollowUp
                await sendDevAlert(interaction, `AniList was unreachable for Manga **"${searchQuery}"**. Fetched via Backup.`);

                return;
            }
        } catch (fallbackErr) {
            console.error('Manga Fallback Error:', fallbackErr);
        }

        return await interaction.editReply(`❌ Sorry, no manga found matching **"${searchQuery}"** on AniList or Emergency Backup.`);
    }

    // 3️⃣ عرض بيانات AniList الرئيسية
    try {
        // فحص المحتوى الخاص بالكبار (18+)
        if (manga.isAdult) {
            let isVerified = false;

            try {
                isVerified = Boolean(await AgeVerification.exists({ userId: interaction.user.id }));
            } catch (err) {
                console.error('Age verification lookup error:', err);
            }

            if (!isVerified) {
                return interaction.editReply({
                    content: `🔞 **This manga contains adult content (18+).**\n\n` +
                             `⚠️ Access requires manual approval from the bot owner. Join the support server to request verification:\n` +
                             `https://discord.gg/H4Af2y4RD8`,
                    embeds: [],
                    components: []
                });
            }
        }

        const title = manga.title?.english || manga.title?.romaji || searchQuery;
        
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setURL(manga.siteUrl || 'https://anilist.co')
            .setThumbnail(manga.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
            .addFields(
                { name: 'Chapters', value: `${manga.chapters ?? 'N/A'}`, inline: true },
                { name: 'Volumes', value: `${manga.volumes ?? 'N/A'}`, inline: true },
                { name: 'Status', value: manga.status || 'N/A', inline: true },
                { name: 'Score', value: manga.averageScore ? `${manga.averageScore} / 100` : 'N/A', inline: true }
            )
            .setDescription('Click "More Info" for more details.')
            .setColor('#33FF57')
            .setFooter({ text: 'AniTracker • Manga Search' });

        await interaction.editReply({
            embeds: [embed],
            components: buildMediaButtons(manga, interaction, 'manga')
        });
    } catch (err) {
        console.error('Manga Command Render Error:', err);
        await interaction.editReply('❌ Failed to display manga data. Please try again!');
    }
}
    // 🎲 Genre Command
    else if (commandName === 'genre') {
            const status = interaction.options.getString('status');
            await interaction.reply({
                content: '📚 First choose what you want to discover:',
                components: [buildMediaTypeMenu(status)],
                ephemeral: true
            });
    }

   // 🎯 Track Command (Server Only + Emergency Fallback)
else if (commandName === 'track') {
    // 1️⃣ التحقق من وجود الأمر داخل سيرفر
    if (!interaction.guildId) {
        return interaction.reply({
            content: '🎯 `/track` works inside a server channel! Want personal alerts instead? Try `/favorite <title>` — you\'ll get a DM whenever a new episode drops.',
            flags: 64
        });
    }

    // 2️⃣ التحقق من صلاحيات العضو (يجب أن يملك صلاحية إدارة القنوات)
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({
            content: '❌ You need **Manage Channels** permission to set up tracking in this server.',
            flags: 64
        });
    }

    await interaction.deferReply();
    const searchQuery = interaction.options.getString('title');
    const requestedMedia = interaction.options.getString('media') || 'anime';

    if (requestedMedia === 'manga') {
        try {
            const manga = await fetchMangaDexSearch(searchQuery);
            if (!manga) return interaction.editReply(`❌ No manga found for **"${searchQuery}"** on MangaDex.`);
            const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: manga.id });
            if (existing) return interaction.editReply(`🎯 **${manga.title}** is already being tracked in this server!`);
            const latestChapter = await fetchMangaDexLatestChapter(manga.id).catch(() => Number(manga.chapters) || 0);
            const channelId = await getServerAlertChannelId(interaction.guildId, interaction.channelId);
            await TrackedItem.create({
                guildId: interaction.guildId,
                channelId,
                animeId: manga.id,
                animeTitle: manga.title,
                mediaType: 'manga',
                lastEpisodes: latestChapter,
                lastStatus: manga.status,
                source: 'mangadex'
            });
            return interaction.editReply(`🎯 Now tracking manga **[${manga.title}](${manga.siteUrl})** in <#${channelId}>.`);
        } catch (err) {
            console.error('Track MangaDex command error:', err.message);
            return interaction.editReply('❌ MangaDex is temporarily unavailable. Please try again later.');
        }
    }

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

    // 3️⃣ المحاولة الأولى: AniList API
    try {
        const data = await fetchAniList(gqlQuery, { search: searchQuery });
        anime = data?.Media;
    } catch (err) {
        console.error('Track AniList Fetch Error:', err.message);
    }

    // 4️⃣ المحاولة الثانية (Emergency Backup - Kitsu API)
    if (!anime) {
        console.log(`AniList failed or returned no data for track [${searchQuery}]. Attempting Backup...`);
        try {
            const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`);
            const kitsuData = await res.json();
            const kitsuAnime = kitsuData?.data?.[0];

            if (kitsuAnime) {
                const attr = kitsuAnime.attributes;
                // حماية الـ ID بإضافة بادئة تمنع التضارب مع AniList IDs
                const kitsuId = `kitsu_${kitsuAnime.id}`;
                const animeTitle = attr.canonicalTitle || attr.titles?.en || searchQuery;
                const coverUrl = attr.posterImage?.large || 'https://i.imgur.com/AGv4yDI.png';
                const siteUrl = `https://kitsu.io/anime/${kitsuAnime.id}`;
                const animeStatus = attr.status ? attr.status.toUpperCase() : 'UNKNOWN';

                const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: kitsuId });
                if (existing) {
                    return await interaction.editReply(`⚠️ **${animeTitle}** is already being tracked in this server!`);
                }

                await TrackedItem.create({
                    guildId: interaction.guildId,
                    channelId: await getServerAlertChannelId(interaction.guildId, interaction.channelId),
                    animeId: kitsuId,
                    animeTitle: animeTitle,
                    lastEpisodes: attr.episodeCount || 0,
                    lastStatus: animeStatus,
                    source: 'kitsu'
                });

                const embed = new EmbedBuilder()
                    .setTitle('🎯 Tracking Started!')
                    .setDescription(`Now tracking **[${animeTitle}](${siteUrl})** in <#${await getServerAlertChannelId(interaction.guildId, interaction.channelId)}>.\nYou will receive alerts there when new episodes release!`)
                    .setThumbnail(coverUrl)
                    .setColor('#3498db')
                    .setFooter({ text: 'AniTracker • Emergency Backup' });

                await interaction.editReply({ embeds: [embed] });

                // تنبيه المطور عبر الـ DM
                await sendDevAlert(interaction, `AniList was unreachable for \`/track\` (${searchQuery}). Processed via Emergency Backup (Kitsu).`);

                return;
            }
        } catch (backupErr) {
            console.error('Track Backup Fetch Error:', backupErr);
        }

        return await interaction.editReply(`❌ Could not find **"${searchQuery}"** on AniList or Emergency Backup.`);
    }

    // 5️⃣ حفظ بيانات AniList الرئيسية
    try {
        const animeTitle = anime.title?.english || anime.title?.romaji || searchQuery;
        const animeId = String(anime.id);
        const animeEpisodes = anime.episodes || 0;
        const animeStatus = anime.status || 'UNKNOWN';
        const coverUrl = anime.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png';
        const siteUrl = anime.siteUrl || 'https://anilist.co';

        const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: animeId });
        if (existing) {
            return await interaction.editReply(`⚠️ **${animeTitle}** is already being tracked in this server!`);
        }

        await TrackedItem.create({
            guildId: interaction.guildId,
            channelId: await getServerAlertChannelId(interaction.guildId, interaction.channelId),
            animeId: animeId,
            animeTitle: animeTitle,
            lastEpisodes: animeEpisodes,
            lastStatus: animeStatus,
            source: 'anilist'
        });

        const embed = new EmbedBuilder()
            .setTitle('🎯 Tracking Started!')
            .setDescription(`Now tracking **[${animeTitle}](${siteUrl})** in <#${interaction.channelId}>.\nYou will receive alerts here when new episodes release!`)
            .setThumbnail(coverUrl)
            .setColor('#3498db')
            .setFooter({ text: 'AniTracker • Server Tracking' });

        await interaction.editReply({ embeds: [embed] });

    } catch (err) {
        console.error('Track Command Error:', err);
        await interaction.editReply('❌ Failed to track this anime. Please try again later!');
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
                const kitsuId = `kitsu_${kitsuAnime.id}`;
                const animeTitle = kitsuAnime.attributes?.canonicalTitle || searchQuery;

                const deleted = await TrackedItem.findOneAndDelete({ guildId: interaction.guildId, animeId: kitsuId });

                if (deleted) {
                    // Dev Alert
                    await sendDevAlert(interaction, 'AniList was unreachable for `/untrack`. Processed via Emergency Backup (Kitsu).');
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
           return await interaction.editReply({
               content: 'No anime or manga is currently being tracked in this server. Use `/track <title>` to start tracking!'
           });
        }

        await interaction.editReply({
           content: '📌 Choose a tracked anime or manga to view its details:',
            components: buildSavedMediaComponents(
               'mytracked_type_select',
                items,
                'Choose a tracked anime or manga',
                'tracked'
            )
        });
    } catch (err) {
        console.error('MyTracked Command Error:', err);
        await interaction.editReply('Failed to fetch tracked list.');
    }
}
   // 🩺 Owner Health Command
   else if (commandName === 'health') {
       const DEV_ID = process.env.DEV_USER_ID || '1326815636395003966';
       if (interaction.user.id !== DEV_ID) {
           return interaction.reply({
               content: '🚫 This command is reserved for the bot owner.',
               flags: MessageFlags.Ephemeral
           });
       }

       await interaction.deferReply({ flags: MessageFlags.Ephemeral });
       const startedAt = Date.now();
       let proxyStatus = '❌ Offline';

       try {
           const healthQuery = 'query { Media(id: 1, type: ANIME) { id } }';
           const proxyStart = Date.now();
           const proxyData = await fetchAniList(healthQuery, {});
           proxyStatus = proxyData ? `✅ Online (${Date.now() - proxyStart}ms)` : '❌ Unavailable';
       } catch (err) {
           console.error('health proxy check error:', err);
       }

       const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
       const dbStatus = dbStates[mongoose.connection.readyState] || 'unknown';
       const embed = new EmbedBuilder()
           .setTitle('🩺 AniTracker Health')
           .setColor(dbStatus === 'connected' && proxyStatus.startsWith('✅') ? '#2ecc71' : '#f1c40f')
           .addFields(
               { name: 'Discord', value: interaction.client.ws.status === 0 ? '✅ Connected' : `⚠️ Status ${interaction.client.ws.status}`, inline: true },
               { name: 'MongoDB', value: dbStatus === 'connected' ? '✅ Connected' : `⚠️ ${dbStatus}`, inline: true },
               { name: 'AniList Proxy', value: proxyStatus, inline: true },
               { name: 'Uptime', value: `${Math.floor(process.uptime() / 60)} minutes`, inline: true },
               { name: 'Response', value: `${Date.now() - startedAt}ms`, inline: true },
               { name: 'Memory', value: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS`, inline: true }
           )
           .setTimestamp()
           .setFooter({ text: 'AniTracker • Owner diagnostics' });

       return interaction.editReply({ embeds: [embed] });
   }
   // 🧪 Test Alert Command (Dev Only)
   else if (commandName === 'testalert') {
    const DEV_ID = process.env.DEV_USER_ID || '1326815636395003966';

    // 1️⃣ حماية الأمر للمطور فقط
    if (interaction.user.id !== DEV_ID) {
        return interaction.reply({
            content: '🚫 This command is reserved for the bot developer only.',
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const startTime = Date.now();

    try {
        console.log(`[Dev Action]: ${interaction.user.tag} triggered manual checkUpdates()...`);
        
        // 2️⃣ تشغيل الفحص التلقائي (وجمع النتيجة لو الدالة بترجع إحصائيات)
        const stats = await runUpdateChecks(); 
        const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);

        // 3️⃣ تجهيز Embed توضيحي للمطور بالتفاصيل
        const embed = new EmbedBuilder()
            .setTitle('🧪 Manual Alert Check Complete')
            .setColor('#2ecc71')
            .setDescription(`Successfully executed \`checkUpdates()\` in **${executionTime}s**.`)
            .addFields(
                { 
                    name: '📊 Server Alerts Sent', 
                    value: `\`${stats?.channelAlertsCount ?? 'Done'}\``, 
                    inline: true 
                },
                { 
                    name: '📬 Personal DMs Sent', 
                    value: `\`${stats?.dmAlertsCount ?? 'Done'}\``, 
                    inline: true 
                },
                { 
                    name: '🔍 Total Items Checked', 
                    value: `\`${stats?.totalChecked ?? 'All'}\``, 
                    inline: true 
                }
            )
            .setFooter({ text: 'AniTracker • Developer Testing Suite' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (err) {
        console.error('testalert command error:', err);
        
        const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
        
        await interaction.editReply({
            content: `❌ **\`checkUpdates()\` failed after ${executionTime}s!**\n\`\`\`javascript\n${err.message || err}\n\`\`\`\nCheck the console logs for full stack trace.`
        });
    }
}
// 🔄 Automated Episode Checker Function
async function runUpdateChecks() {
    try {
        // 1. Check Channel Tracked Items (Server Trackers)
        const tracked = await TrackedItem.find({});
        
        for (const item of tracked) {
            try {
                if (item.mediaType === 'manga' || item.source === 'mangadex') {
                    const currentChapter = await fetchMangaDexLatestChapter(item.animeId);
                    if (currentChapter > (item.lastEpisodes || 0)) {
                        const serverSettings = await ServerSettings.findOne({ guildId: item.guildId }).lean();
                        if (serverSettings?.serverAlertsEnabled !== false) {
                            const channel = await client.channels.fetch(item.channelId).catch(() => null);
                            if (channel) {
                                const embed = new EmbedBuilder()
                                    .setTitle('🚨 New Manga Chapter Alert!')
                                    .setDescription(`**[${item.animeTitle}](https://mangadex.org/title/${item.animeId})** has a new chapter!\n\n📖 **Latest Chapter:** ${currentChapter}`)
                                    .setColor('#e74c3c')
                                    .setTimestamp();
                                await channel.send({ embeds: [embed] }).catch(err => console.error(`Failed to send manga alert:`, err.message));
                            }
                        }
                        item.lastEpisodes = currentChapter;
                        await item.save();
                    }
                    continue;
                }
                const isKitsu = item.source === 'kitsu' || String(item.animeId).startsWith('kitsu_');
                const animeId = Number(item.animeId);
                if (!isKitsu && !Number.isInteger(animeId)) {
                    continue;
                }

                let anime;
                if (isKitsu) {
                    anime = await fetchKitsuAnime(String(item.animeId).replace(/^kitsu_/, ''));
                } else {
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

                    const data = await fetchAniList(gqlQuery, { id: animeId });
                    anime = data?.Media;
                }

                if (anime) {
                    const currentEps = isKitsu ? anime.episodes : getAiredEpisodes(anime);
                    const lastEps = item.lastEpisodes || 0;

                    if (currentEps > lastEps) {
                        const serverSettings = await ServerSettings.findOne({ guildId: item.guildId }).lean();
                        if (serverSettings?.serverAlertsEnabled === false) {
                            continue;
                        }

                        const channel = await client.channels.fetch(item.channelId).catch(() => null);

                        if (channel) {
                            const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || anime.title || item.animeTitle;
                            const siteUrl = anime.siteUrl || 'https://anilist.co';
                            const coverUrl = (anime.coverImage && anime.coverImage.large) || anime.image || 'https://i.imgur.com/AGv4yDI.png';

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
                if (item.mediaType === 'manga' || item.source === 'mangadex') {
                    const currentChapter = await fetchMangaDexLatestChapter(item.animeId);
                    if (currentChapter > (item.lastEpisodes || 0)) {
                        const userSettings = await UserSettings.findOne({ userId: item.userId }).lean();
                        const user = userSettings?.favoriteDmsEnabled === false
                            ? null
                            : await client.users.fetch(item.userId).catch(() => null);
                        if (user) {
                            const embed = new EmbedBuilder()
                                .setTitle('⭐ Favorite Manga Update!')
                                .setDescription(`A new chapter of **[${item.animeTitle}](https://mangadex.org/title/${item.animeId})** is out!\n\n📖 **Latest Chapter:** ${currentChapter}`)
                                .setColor('#f1c40f')
                                .setTimestamp();
                            await user.send({ embeds: [embed] }).catch(() => {});
                        }
                        item.lastEpisodes = currentChapter;
                        await item.save();
                    }
                    continue;
                }
                let anime;
                if (item.source === 'kitsu' || String(item.animeId).startsWith('kitsu_')) {
                    anime = await fetchKitsuAnime(String(item.animeId).replace(/^kitsu_/, ''));
                } else {
                    const animeId = Number(item.animeId);
                    if (!Number.isInteger(animeId)) {
                        continue;
                    }

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

                    const data = await fetchAniList(gqlQuery, { id: animeId });
                    anime = data?.Media;
                }

                if (anime) {
                    const currentEps = item.source === 'kitsu' || String(item.animeId).startsWith('kitsu_')
                        ? anime.episodes
                        : getAiredEpisodes(anime);
                    const lastEps = item.lastEpisodes || 0;

                    if (currentEps > lastEps) {
                        const userSettings = await UserSettings.findOne({ userId: item.userId }).lean();
                        if (userSettings?.favoriteDmsEnabled === false) {
                            continue;
                        }

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
