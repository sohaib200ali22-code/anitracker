const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ActivityType, PermissionFlagsBits } = require('discord.js');
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

// AniList API GraphQL Helper Function
async function fetchAniList(query, variables) {
    const response = await axios.post('https://graphql.anilist.co', {
        query,
        variables
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: 10000
    });
    return response.data.data;
}

// FIX: AniList's `episodes` field is the total (planned) episode count, not
// "how many episodes have aired so far". For currently-airing anime this
// barely ever changes, so the old code (comparing raw `episodes`) almost
// never detected a new episode. This helper derives the actual aired count
// using `nextAiringEpisode` while a show is releasing, falling back to the
// total once it has finished.
function getAiredEpisodes(anime) {
    if (anime.status === 'RELEASING' && anime.nextAiringEpisode?.episode) {
        return anime.nextAiringEpisode.episode - 1;
    }
    return anime.episodes || 0;
}

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
        .setDescription('Choose Anime or Manga, then get a recommendation by category'),
    new SlashCommandBuilder()
        .setName('track')
        .setDescription('Track an anime for new episode updates in this channel')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Anime title to track')
                .setRequired(true)),
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

    // Background Tracker Loop (Checks every 30 minutes)
    setInterval(checkUpdates, 30 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    // 🎲 Genre recommendation menus
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
                        content: '🔞 This category is restricted to verified adults. Please talk to the bot owner in DMs for age verification first.',
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
            query ($type: MediaType, $genre: String, $tag: String) {
              Page (page: 1, perPage: 10) {
                media (type: $type, genre: $genre, tag: $tag, sort: SCORE_DESC) {
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

            try {
                const data = await fetchAniList(gqlQuery, {
                    type: mediaType === 'manga' ? 'MANGA' : 'ANIME',
                    genre: genreDefinition.filterType === 'genre' ? genreDefinition.apiValue : null,
                    tag: genreDefinition.filterType === 'tag' ? genreDefinition.apiValue : null
                });
                const mediaList = data?.Page?.media;

                if (!mediaList || mediaList.length === 0) {
                    return interaction.editReply({
                        content: `No ${mediaType} found for **${genreDefinition.label}**.`,
                        components: []
                    });
                }

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
                    if (interaction.guildId) buttons.unshift(trackBtn);
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

    // 🔘 Handle Interactive Buttons
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

            try {
                const data = await fetchAniList(gqlQuery, { id: animeId });
                const anime = data?.Media;

                if (!anime) return interaction.editReply({ content: 'Anime not found!' });

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
            } catch (err) {
                await interaction.editReply({ content: 'Failed to track via button.' });
            }
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

            try {
                const data = await fetchAniList(gqlQuery, { id: animeId });
                const anime = data?.Media;

                if (!anime) return interaction.editReply({ content: 'Anime not found!' });

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
            } catch (err) {
                await interaction.editReply({ content: 'Failed to add to personal favorites.' });
            }
        }
        // FIX: this handler was completely missing, so the "📖 More Info" button
        // on /character results just failed silently ("This interaction failed").
        else if (interaction.customId.startsWith('char_info_')) {
            await interaction.deferReply({ ephemeral: true });
            const charId = parseInt(interaction.customId.replace('char_info_', ''));

            // FIX: expanded the query — added description, image, and the anime
            // appearances + Japanese voice actor so "More Info" actually shows
            // more useful data than before, not just name/age/gender.
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

            try {
                const data = await fetchAniList(gqlQuery, { id: charId });
                const char = data?.Character;

                if (!char) return interaction.editReply({ content: 'Character not found!' });

                const altNames = char.name?.alternative?.filter(Boolean).join(', ') || 'N/A';
                const dob = (char.dateOfBirth && (char.dateOfBirth.month || char.dateOfBirth.day))
                    ? `${char.dateOfBirth.month ?? '?'}/${char.dateOfBirth.day ?? '?'}`
                    : 'N/A';

                // FIX: full bio, not cut off — same spoiler/HTML cleanup as the
                // main /character command, capped only at Discord's hard embed
                // description limit (4096 chars) as a safety net, not a real truncation.
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
            } catch (err) {
                console.error('char_info button error:', err);
                await interaction.editReply({ content: 'Failed to fetch character info.' });
            }
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
        if (interaction.user.id !== process.env.DEV_USER_ID) {
            return interaction.reply({ content: '🚫 Only the bot owner can approve age verification, owner username: _h8rtless_.', ephemeral: true });
        }

        const user = interaction.options.getUser('user');

        try {
            // 1. التحديث في قاعدة البيانات
            await AgeVerification.updateOne(
                { userId: user.id },
                { $set: { userId: user.id, verifiedAt: new Date() } },
                { upsert: true }
            );

            // 2. إرسال رسالة في الخاص للمستخدم
            let dmSent = true;
            try {
                await user.send('🎉 **Congratulations!** Your age verification has been approved. You now have access to 18+ content.');
            } catch (dmErr) {
                dmSent = false; // في حال كان الخاص مقفول عند المستخدم
            }

            // 3. الرد على الأدمن
            const dmStatusText = dmSent ? '📬 DM notification sent to the user.' : '⚠️ Could not send DM (User DMs might be closed).';
            await interaction.reply({
                content: `✅ **${user.tag}** is now approved for 18+ genre recommendations.\n${dmStatusText}`,
                ephemeral: true
            });

        } catch (err) {
            console.error('verifyage command error:', err);
            await interaction.reply({ content: '❌ Could not save the age verification. Please try again.', ephemeral: true });
        }
    }

    // 🔞 Owner-controlled age verification (Approve)
    else if (commandName === 'verifyage') {
        if (interaction.user.id !== process.env.DEV_USER_ID) {
            return interaction.reply({ content: '🚫 Only the bot owner can approve age verification, owner username: _h8rtless_.', ephemeral: true });
        }

        const user = interaction.options.getUser('user');

        try {
            await AgeVerification.updateOne(
                { userId: user.id },
                { $set: { userId: user.id, verifiedAt: new Date() } },
                { upsert: true }
            );

            // إرسال رسالة DM للمستخدم لتأكيد التوثيق وفك الحجب عن المحتوى
            let dmSent = true;
            try {
                await user.send(`🎉 **Age Verification Approved!**\nYour account has been verified by the owner. You can now request and view 18+ adult genre recommendations linked to AniList.`);
            } catch (dmErr) {
                dmSent = false;
            }

            const dmStatusText = dmSent ? '📬 DM notification sent.' : '⚠️ Could not send DM (User DMs are closed).';
            await interaction.reply({
                content: `✅ **${user.tag}** is now approved for 18+ AniList genre recommendations.\n${dmStatusText}`,
                ephemeral: true
            });

        } catch (err) {
            console.error('verifyage command error:', err);
            await interaction.reply({ content: '❌ Could not save the age verification. Please try again.', ephemeral: true });
        }
    }

    // 🚫 Owner-controlled age unverification (Remove)
    else if (commandName === 'unverifyage') {
        if (interaction.user.id !== process.env.DEV_USER_ID) {
            return interaction.reply({ content: '🚫 Only the bot owner can remove age verification.', ephemeral: true });
        }

        const user = interaction.options.getUser('user');

        try {
            // التأكد أولاً إذا كان المستخدم موثق
            const existingVerification = await AgeVerification.findOne({ userId: user.id });

            if (!existingVerification) {
                return interaction.reply({
                    content: `⚠️ **${user.tag}** is not currently age-verified.`,
                    ephemeral: true
                });
            }

            // مسح التوثيق من قاعدة البيانات
            await AgeVerification.deleteOne({ userId: user.id });

            // إرسال DM للمستخدم لإبلاغه بسحب التوثيق
            let dmSent = true;
            try {
                await user.send(`🔒 **Age Verification Removed.**\nYour 18+ access status for AniList content has been revoked by the bot owner.`);
            } catch (dmErr) {
                dmSent = false;
            }

            const dmStatusText = dmSent ? '📬 DM notification sent.' : '⚠️ Could not send DM (User DMs are closed).';
            await interaction.reply({
                content: `🗑️ Age verification removed for **${user.tag}**. 18+ AniList recommendations are now locked for this user.\n${dmStatusText}`,
                ephemeral: true
            });

        } catch (err) {
            console.error('unverifyage command error:', err);
            await interaction.reply({ content: '❌ Could not remove age verification. Please try again.', ephemeral: true });
        }
    }
   
        // 🎭 Character Search Command (Updated to AniList API for 100% stability)
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

        try {
            const data = await fetchAniList(gqlQuery, { search: characterName });
            const char = data?.Character;

            if (!char) {
                return await interaction.editReply(`❌ Sorry, no character found with the name **"${characterName}"**.`);
            }

            const nameFull = char.name?.full || characterName;
            const nameNative = char.name?.native ? ` (${char.name.native})` : '';
            // FIX: the query only requests `edges { node {...} } }`, not `nodes`,
            // so `char.media.nodes` was always undefined and this fell back to
            // "Unknown Anime" every time. Read from edges[0].node instead.
            const animeSource = char.media?.edges?.[0]?.node?.title?.english
                || char.media?.edges?.[0]?.node?.title?.romaji
                || 'Unknown Anime';

            let cleanDesc = char.description ? char.description
                .replace(/~!/g, '||')
                .replace(/!~/g, '||')
                .replace(/<[^>]*>/gm, '') : 'No description available.';
            // FIX: reverted to a short description in the main /character result —
            // the full/long bio now only shows up when the user presses "More Info".
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

            // FIX: removed the leftover/duplicate "fanartBtn" block that referenced
            // an undefined `pinterestUrl` variable (ReferenceError) and was dead
            // code anyway — only `infoBtn` + `animeFanartBtn` were actually used.
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
            // FIX: this whole try block had no catch/finally in the original code,
            // which is a hard SyntaxError in JS — the file would not even load.
            console.error('Character command error:', err);
            await interaction.editReply('Failed to fetch character data.');
        }
    }

    // ⭐ Favorite Command
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

        try {
            const data = await fetchAniList(gqlQuery, { search: searchQuery });
            const anime = data?.Media;

            if (!anime) return interaction.editReply('Anime not found! Please check the title and try again.');

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
            console.error(err);
            await interaction.editReply('Failed to add to personal favorites.');
        }
    }
    // ❌ Unfavorite Command
    else if (commandName === 'unfavorite') {
        await interaction.deferReply({ ephemeral: true });
        const searchQuery = interaction.options.getString('title');

        const gqlQuery = `
        query ($search: String) {
          Media (search: $search, type: ANIME) {
            id
            title { romaji english }
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { search: searchQuery });
            const anime = data?.Media;

            if (!anime) return interaction.editReply('Anime not found!');

            const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || searchQuery;
            const deleted = await FavoriteItem.findOneAndDelete({ userId: interaction.user.id, animeId: anime.id });

            if (!deleted) {
                return interaction.editReply(`**${animeTitle}** was not in your favorites list.`);
            }

            await interaction.editReply(`🗑️ Removed **${animeTitle}** from your personal favorites.`);
        } catch (err) {
            await interaction.editReply('Failed to remove from favorites.');
        }
    }

    // 💖 My Favorites Command (Hidden/Ephemeral)
    else if (commandName === 'myfavorites') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const favorites = await FavoriteItem.find({ userId: interaction.user.id });
            if (favorites.length === 0) {
                return interaction.editReply('You currently have no anime saved in your personal favorites.');
            }

            const list = favorites.map((item, index) => `${index + 1}. **${item.animeTitle}**`).join('\n');
            const embed = new EmbedBuilder()
                .setTitle('⭐ Your Personal Favorite Anime List')
                .setDescription(list)
                .setColor('#f39c12')
                .setFooter({ text: 'You will receive Direct Messages when new episodes air!' });

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch favorites list.');
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
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { search: searchQuery });
            const anime = data?.Media;

            if (!anime) return interaction.editReply('Anime not found!');

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

            const trackBtn = new ButtonBuilder()
                .setCustomId(`track_btn_${anime.id}`)
                .setLabel('🎯 Channel Track')
                .setStyle(ButtonStyle.Success);

            const favBtn = new ButtonBuilder()
                .setCustomId(`fav_btn_${anime.id}`)
                .setLabel('⭐ Favorite (DM Alert)')
                .setStyle(ButtonStyle.Primary);

            const buttons = [favBtn];
            if (interaction.guildId) {
                buttons.unshift(trackBtn);
            }

            const row = new ActionRowBuilder().addComponents(...buttons);

            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (err) {
            await interaction.editReply('Failed to fetch anime data.');
        }
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
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { search: searchQuery });
            const manga = data?.Media;

            if (!manga) return interaction.editReply('Manga not found!');

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
            await interaction.editReply('Failed to fetch manga data.');
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

    // 🎯 Track Command
    else if (commandName === 'track') {
        // FIX: only a runtime guard now (no more setDMPermission) — this shows our
        // own friendly message instead of Discord's default scary red error.
        if (!interaction.guildId) {
            return interaction.reply({
                content: '🎯 `/track` works inside a server channel! Want personal alerts instead? Try `/favorite <title>` — you\'ll get a DM whenever a new episode drops.',
                ephemeral: true
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

        try {
            const data = await fetchAniList(gqlQuery, { search: searchQuery });
            const anime = data?.Media;

            if (!anime) {
                return await interaction.editReply('Anime not found!');
            }

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
            await interaction.editReply(`Failed to track this anime. Details: ${err.message}`);
        }
    }

    // 🛑 Untrack Command
    else if (commandName === 'untrack') {
        await interaction.deferReply();
        const searchQuery = interaction.options.getString('title');

        const gqlQuery = `
        query ($search: String) {
          Media (search: $search, type: ANIME) {
            id
            title { romaji english }
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { search: searchQuery });
            const anime = data?.Media;

            if (!anime) return interaction.editReply('Anime not found!');

            const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || searchQuery;
            const deleted = await TrackedItem.findOneAndDelete({ guildId: interaction.guildId, animeId: anime.id });

            if (!deleted) {
                return interaction.editReply(`**${animeTitle}** was not being tracked.`);
            }

            await interaction.editReply(`🚨 Stopped tracking **${animeTitle}**.`);
        } catch (err) {
            await interaction.editReply('Failed to untrack.');
        }
    }

    // 📌 List Tracked Command (Hidden/Ephemeral)
    else if (commandName === 'mytracked') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const items = await TrackedItem.find({ guildId: interaction.guildId });
            if (items.length === 0) {
                return interaction.editReply('No anime is currently being tracked in this server.');
            }

            const list = items.map((item, index) => `${index + 1}. **${item.animeTitle}** (Channel: <#${item.channelId}>)`).join('\n');
            const embed = new EmbedBuilder()
                .setTitle('📌 Tracked Anime List')
                .setDescription(list)
                .setColor('#f1c40f');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch tracked list.');
        }
    }

    // 🧪 Test Alert Command (Dev only)
    else if (commandName === 'testalert') {
        if (interaction.user.id !== process.env.DEV_USER_ID) {
            return interaction.reply({ content: '🚫 This command is for the bot developer only.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        try {
            await checkUpdates();
            await interaction.editReply('✅ Alert check complete — go check your tracked channels and DMs for any new-episode alerts.');
        } catch (err) {
            console.error('testalert command error:', err);
            await interaction.editReply('❌ checkUpdates() threw an error — check the logs.');
        }
    }
});

// Automated Episode Checker Function
async function checkUpdates() {
    try {
        // If an anime is also in personal favorites, the DM notification wins
        // and the channel notification is suppressed to avoid duplicate alerts.
        const favorites = await FavoriteItem.find({});
        const favoriteAnimeIds = new Set(favorites.map(item => item.animeId));

        // 1. Check Channel Tracked Items
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
                    // FIX: use the aired-episode helper instead of raw `anime.episodes`
                    // (see getAiredEpisodes comment above) so releases are actually detected.
                    const currentEps = getAiredEpisodes(anime);
                    const lastEps = item.lastEpisodes || 0;

                    if (currentEps > lastEps) {
                        if (favoriteAnimeIds.has(item.animeId)) {
                            // Keep the tracker in sync without sending its channel
                            // alert; the matching favorite will send the DM below.
                            item.lastEpisodes = currentEps;
                            item.lastStatus = anime.status || item.lastStatus;
                            await item.save();
                            continue;
                        }

                        const channel = await client.channels.fetch(item.channelId).catch(() => null);
                        if (channel) {
                            const animeTitle = (anime.title && (anime.title.english || anime.title.romaji)) || item.animeTitle;
                            const siteUrl = anime.siteUrl || 'https://anilist.co';
                            const coverUrl = (anime.coverImage && anime.coverImage.large) || 'https://i.imgur.com/AGv4yDI.png';

                            const embed = new EmbedBuilder()
                                .setTitle('🚨 New Episode Alert!')
                                .setDescription(`**[${animeTitle}](${siteUrl})** has released new episodes!\n\n📺 **New Episode Count:** ${currentEps}`)
                                .setThumbnail(coverUrl)
                                .setColor('#e74c3c')
                                .setTimestamp();

                            await channel.send({ embeds: [embed] });
                        } else {
                            // FIX: channel was deleted/inaccessible — stop polling for it forever.
                            await TrackedItem.deleteOne({ _id: item._id });
                            continue;
                        }

                        // Update Database
                        item.lastEpisodes = currentEps;
                        item.lastStatus = anime.status || item.lastStatus;
                        await item.save();
                    }
                }
            } catch (err) {
                console.error(`Error checking channel update for anime ID ${item.animeId}:`, err.message);
            }

            await sleep(300); // gentle pacing to stay under AniList's rate limit
        }

        // 2. Check Personal Favorites (DM Alerts)
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

                            await user.send({ embeds: [embed] }).catch(() => null);
                        }

                        // Update Database
                        item.lastEpisodes = currentEps;
                        await item.save();
                    }
                }
            } catch (err) {
                console.error(`Error checking DM update for user ${item.userId}:`, err.message);
            }

            await sleep(300);
        }
    } catch (err) {
        console.error('Error in checkUpdates loop:', err);
    }
}

// Log in to Discord
client.login(process.env.DISCORD_TOKEN);
