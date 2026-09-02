const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const http = require('http');
const mongoose = require('mongoose');
require('dotenv').config();

// Keep Render alive
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.write("AniTracker is running!");
    res.end();
}).listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

setInterval(() => {
    http.get(`http://localhost:${PORT}`, (res) => {}).on('error', (err) => {});
}, 5 * 60 * 1000);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB Atlas!'))
    .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schemas
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

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences
    ] 
});

const DEV_USER_ID = process.env.DEV_USER_ID;
const SUPPORT_SERVER_URL = process.env.SUPPORT_SERVER_URL || 'https://discord.gg/ZpQcRpZBrB';

// Native Node.js Fetch function for AniList API (No external dependencies required!)
async function fetchAniList(query, variables = {}) {
    try {
        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            body: JSON.stringify({ query, variables })
        });

        const json = await response.json();

        if (json.errors && json.errors.length > 0) {
            console.error('[AniList GraphQL Error]:', json.errors);
            throw new Error(json.errors[0].message);
        }

        return json.data;
    } catch (err) {
        console.error('[AniList Fetch Failure]:', err.message);
        throw err;
    }
}

// Global Command Helper Function
function createCommand(name, description) {
    return new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
        .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel]);
}

// Commands Setup
const commands = [
    createCommand('start', 'Welcome guide, basic features, and support contact'),
    
    createCommand('report', 'Send a direct bug report or suggestion to the developer')
        .addStringOption(option => 
            option.setName('message')
                .setDescription('Describe the issue or suggestion')
                .setRequired(true)),
                
    createCommand('favorite', 'Add an anime to your personal favorites (Receive DM notifications)')
        .addStringOption(option => 
            option.setName('title')
                .setDescription('Anime title to add to favorites')
                .setRequired(true)),
                
    createCommand('unfavorite', 'Remove an anime from your personal favorites')
        .addStringOption(option => 
            option.setName('title')
                .setDescription('Anime title to remove from favorites')
                .setRequired(true)),
                
    createCommand('myfavorites', 'List all your personal favorite anime'),
    
    createCommand('help', 'Displays a list of available commands and bot usage guide'),
    
    createCommand('anime', 'Search for an anime')
        .addStringOption(option => 
            option.setName('title')
                .setDescription('Anime title')
                .setRequired(true)),
                
    createCommand('manga', 'Search for a manga')
        .addStringOption(option => 
            option.setName('title')
                .setDescription('Manga title')
                .setRequired(true)),
                
    createCommand('genre', 'Find a currently releasing high-rated anime by genre')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Choose a genre')
                .setRequired(true)
                .addChoices(
                    { name: 'Action', value: 'Action' },
                    { name: 'Adventure', value: 'Adventure' },
                    { name: 'Comedy', value: 'Comedy' },
                    { name: 'Fantasy', value: 'Fantasy' },
                    { name: 'Romance', value: 'Romance' },
                    { name: 'Sci-Fi', value: 'Sci-Fi' },
                    { name: 'Horror', value: 'Horror' },
                    { name: 'Sports', value: 'Sports' },
                    { name: 'Slice of Life', value: 'Slice of Life' }
                )),
                
    createCommand('track', 'Track an anime for new episode updates in this channel')
        .addStringOption(option => 
            option.setName('title')
                .setDescription('Anime title to track')
                .setRequired(true)),
                
    createCommand('untrack', 'Stop tracking an anime in this channel')
        .addStringOption(option => 
            option.setName('title')
                .setDescription('Anime title to untrack')
                .setRequired(true)),
                
    createCommand('mytracked', 'List all tracked anime in this server'),

    createCommand('schedule', 'Get today\'s releasing anime schedule with local times'),

    createCommand('top', 'Get top 1 to 50 highest-rated anime or manga')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Choose Anime or Manga')
                .setRequired(true)
                .addChoices(
                    { name: 'Anime', value: 'ANIME' },
                    { name: 'Manga', value: 'MANGA' }
                ))
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription('Number of items to fetch (1 - 50)')
                .setMinValue(1)
                .setMaxValue(50)
                .setRequired(false)),

    createCommand('character', 'Search for an anime character')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Character name')
                .setRequired(true))
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    client.user.setActivity('AniList for new episodes 📺', { type: ActivityType.Watching });
    client.user.setStatus('online');

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Started refreshing global application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('Successfully reloaded global application (/) commands!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }

    setInterval(checkUpdates, 30 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId.startsWith('track_btn_')) {
            await interaction.deferReply({ ephemeral: true });
            const animeId = parseInt(customId.replace('track_btn_', ''));

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

                const animeTitle = anime.title.english || anime.title.romaji || 'Unknown Anime';
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
        else if (customId.startsWith('fav_btn_')) {
            await interaction.deferReply({ ephemeral: true });
            const animeId = parseInt(customId.replace('fav_btn_', ''));

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

                const animeTitle = anime.title.english || anime.title.romaji || 'Unknown Anime';
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

                await interaction.editReply({ content: `⭐ Added **[${animeTitle}](${anime.siteUrl})** to your personal favorites!` });
            } catch (err) {
                await interaction.editReply({ content: 'Failed to add to personal favorites.' });
            }
        }
        else if (customId.startsWith('char_va_')) {
            await interaction.deferReply({ ephemeral: true });
            const charId = parseInt(customId.replace('char_va_', ''));

            const gqlQuery = `
            query ($id: Int) {
              Character (id: $id) {
                name { full }
                media (sort: POPULARITY_DESC, perPage: 1) {
                  edges {
                    voiceActors (language: JAPANESE) {
                      name { full }
                      siteUrl
                      image { medium }
                    }
                  }
                }
              }
            }`;

            try {
                const data = await fetchAniList(gqlQuery, { id: charId });
                const char = data?.Character;
                const va = char?.media?.edges?.[0]?.voiceActors?.[0];

                if (!va) return interaction.editReply({ content: 'No Japanese voice actor information available.' });

                const embed = new EmbedBuilder()
                    .setTitle(`🎙️ Voice Actor for ${char.name.full}`)
                    .setDescription(`**[${va.name.full}](${va.siteUrl})**`)
                    .setThumbnail(va.image?.medium || null)
                    .setColor('#121212');

                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                await interaction.editReply({ content: 'Failed to fetch voice actor details.' });
            }
        }
        else if (customId.startsWith('char_art_')) {
            await interaction.deferReply({ ephemeral: true });
            const charId = parseInt(customId.replace('char_art_', ''));

            const gqlQuery = `
            query ($id: Int) {
              Character (id: $id) {
                name { full }
                siteUrl
                image { large }
              }
            }`;

            try {
                const data = await fetchAniList(gqlQuery, { id: charId });
                const char = data?.Character;

                const embed = new EmbedBuilder()
                    .setTitle(`🎨 Fanart Gallery - ${char.name.full}`)
                    .setDescription(`View more artwork and community submissions on **[AniList](${char.siteUrl})**`)
                    .setImage(char.image?.large || null)
                    .setColor('#121212');

                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                await interaction.editReply({ content: 'Failed to load character gallery.' });
            }
        }
        else if (customId.startsWith('top_prev_') || customId.startsWith('top_next_')) {
            await interaction.deferUpdate();
            const parts = customId.split('_');
            const direction = parts[1];
            const type = parts[2];
            let currentPage = parseInt(parts[3]);
            const totalItems = parseInt(parts[4]);

            currentPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
            const totalPages = Math.ceil(totalItems / 10);
            if (currentPage < 1 || currentPage > totalPages) return;

            const gqlQuery = `
            query ($type: MediaType, $perPage: Int) {
              Page (page: 1, perPage: $perPage) {
                media (type: $type, sort: SCORE_DESC) {
                  title { romaji english }
                  averageScore
                  siteUrl
                }
              }
            }`;

            try {
                const data = await fetchAniList(gqlQuery, { type, perPage: totalItems });
                const mediaList = data?.Page?.media || [];

                const startIndex = (currentPage - 1) * 10;
                const pageItems = mediaList.slice(startIndex, startIndex + 10);

                const list = pageItems.map((item, i) => {
                    const title = item.title.english || item.title.romaji || 'Unknown';
                    const score = item.averageScore ? (item.averageScore / 10).toFixed(1) : 'N/A';
                    return `**${startIndex + i + 1}.** [${title}](${item.siteUrl}) — ⭐ **${score}**`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle(`🏆 Top ${type === 'ANIME' ? 'Anime' : 'Manga'} Rankings`)
                    .setDescription(list)
                    .setColor('#121212')
                    .setFooter({ text: `Page ${currentPage} of ${totalPages} • Total: ${totalItems}` });

                const prevBtn = new ButtonBuilder()
                    .setCustomId(`top_prev_${type}_${currentPage}_${totalItems}`)
                    .setLabel('⬅️ Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage === 1);

                const nextBtn = new ButtonBuilder()
                    .setCustomId(`top_next_${type}_${currentPage}_${totalItems}`)
                    .setLabel('Next ➡️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage === totalPages);

                const row = new ActionRowBuilder().addComponents(prevBtn, nextBtn);

                await interaction.editReply({ embeds: [embed], components: [row] });
            } catch (err) {
                console.error('Pagination Error:', err);
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'start') {
        const embed = new EmbedBuilder()
            .setTitle('🚀 Welcome to AniTracker!')
            .setDescription('Your ultimate Discord companion for anime search, recommendations, and automatic episode notifications!')
            .addFields(
                { name: '✨ What can AniTracker do?', value: '• Search Anime, Manga & Characters instantly.\n• Track anime in server channels for group alerts.\n• Add anime to personal favorites for **Direct Message (DM)** updates.\n• Find airing schedules and genre recommendations.' },
                { name: '📚 Quick Start Commands', value: '`/anime` - Search any anime\n`/character` - Find character info\n`/top` - View top rankings\n`/schedule` - Today\'s episode release times\n`/genre` - Discover ongoing anime\n`/report <message>` - Report bugs to developer' },
                { name: '🐛 Support & Feedback', value: `Need help or found a bug? Contact developer or join support server below!` }
            )
            .setColor('#121212')
            .setThumbnail(client.user.displayAvatarURL())
            .setFooter({ text: 'AniTracker • Gothic Edition' });

        const supportBtn = new ButtonBuilder()
            .setLabel('🛠️ Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(SUPPORT_SERVER_URL);

        const row = new ActionRowBuilder().addComponents(supportBtn);

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    else if (commandName === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('🤖 AniTracker - Commands Guide')
            .setDescription('Here is the full list of available slash commands:')
            .addFields(
                { name: '🚀 `/start`', value: 'Welcome guide and basic info.', inline: false },
                { name: '🔍 `/anime <title>`', value: 'Search for anime details, quick track, or favorite.', inline: false },
                { name: '📖 `/manga <title>`', value: 'Search for manga details.', inline: false },
                { name: '👤 `/character <name>`', value: 'Search character info with voice actor & fanart.', inline: false },
                { name: '📅 `/schedule`', value: 'Today\'s airing episodes in your local timezone.', inline: false },
                { name: '🏆 `/top <type> [limit]`', value: 'List top 1-50 anime or manga with interactive pages.', inline: false },
                { name: '🎭 `/genre <category>`', value: 'Discover top currently RELEASING anime by genre.', inline: false },
                { name: '⭐ `/favorite <title>`', value: 'Add anime to personal DM alerts.', inline: false },
                { name: '🎯 `/track <title>`', value: 'Track anime in channel.', inline: false },
                { name: '📩 `/report <message>`', value: 'Send direct report/issue to developer.', inline: false }
            )
            .setColor('#121212')
            .setFooter({ text: 'Report Problem below or join our support server!' });

        const supportBtn = new ButtonBuilder()
            .setLabel('🛠️ Report Problem / Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(SUPPORT_SERVER_URL);

        const row = new ActionRowBuilder().addComponents(supportBtn);

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    else if (commandName === 'schedule') {
        await interaction.deferReply({ ephemeral: true });

        const now = Math.floor(Date.now() / 1000);
        const dayLater = now + 86400;

        const gqlQuery = `
        query ($airingAt_greater: Int, $airingAt_lesser: Int) {
          Page(page: 1, perPage: 15) {
            airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME) {
              episode
              airingAt
              media {
                title { romaji english }
                siteUrl
              }
            }
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { airingAt_greater: now, airingAt_lesser: dayLater });
            const schedules = data?.Page?.airingSchedules;

            if (!schedules || schedules.length === 0) {
                return interaction.editReply('📅 No anime episodes are scheduled to air in the next 24 hours.');
            }

            const scheduleList = schedules.map(item => {
                const title = item.media.title.english || item.media.title.romaji || 'Unknown Anime';
                return `• **[${title}](${item.media.siteUrl})** — Ep **${item.episode}** <t:${item.airingAt}:R>`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setTitle('📅 Upcoming Anime Release Schedule (Next 24 Hours)')
                .setDescription(scheduleList)
                .setColor('#121212');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch airing schedule.');
        }
    }

    else if (commandName === 'top') {
        await interaction.deferReply({ ephemeral: true });
        const type = interaction.options.getString('type');
        const limit = interaction.options.getInteger('limit') || 10;

        const gqlQuery = `
        query ($type: MediaType, $perPage: Int) {
          Page (page: 1, perPage: $perPage) {
            media (type: $type, sort: SCORE_DESC) {
              title { romaji english }
              averageScore
              siteUrl
            }
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { type, perPage: limit });
            const mediaList = data?.Page?.media || [];

            if (mediaList.length === 0) return interaction.editReply('No rankings found.');

            const pageItems = mediaList.slice(0, 10);
            const totalPages = Math.ceil(limit / 10);

            const list = pageItems.map((item, i) => {
                const title = item.title.english || item.title.romaji || 'Unknown';
                const score = item.averageScore ? (item.averageScore / 10).toFixed(1) : 'N/A';
                return `**${i + 1}.** [${title}](${item.siteUrl}) — ⭐ **${score}**`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setTitle(`🏆 Top ${type === 'ANIME' ? 'Anime' : 'Manga'} Rankings`)
                .setDescription(list)
                .setColor('#121212')
                .setFooter({ text: `Page 1 of ${totalPages} • Total: ${limit}` });

            const row = new ActionRowBuilder();
            if (limit > 10) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`top_prev_${type}_1_${limit}`)
                        .setLabel('⬅️ Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`top_next_${type}_1_${limit}`)
                        .setLabel('Next ➡️')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            await interaction.editReply({ embeds: [embed], components: limit > 10 ? [row] : [] });
        } catch (err) {
            await interaction.editReply('Failed to fetch top rankings.');
        }
    }

    else if (commandName === 'genre') {
        await interaction.deferReply({ ephemeral: true });
        const genreChoice = interaction.options.getString('category');

        const gqlQuery = `
        query ($genre: String) {
          Page (page: 1, perPage: 25) {
            media (genre: $genre, type: ANIME, status: RELEASING, sort: POPULARITY_DESC) {
              id
              title { romaji english }
              episodes
              status
              averageScore
              description(asHtml: false)
              coverImage { large }
              siteUrl
            }
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { genre: genreChoice });
            const mediaList = data?.Page?.media;

            if (!mediaList || mediaList.length === 0) {
                return interaction.editReply(`No currently releasing anime found for genre: ${genreChoice}`);
            }

            const anime = mediaList[Math.floor(Math.random() * mediaList.length)];
            const title = anime.title.english || anime.title.romaji || 'Anime Title';
            const cleanDesc = anime.description ? anime.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';
            const score = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : 'N/A';

            const embed = new EmbedBuilder()
                .setTitle(`🎭 ${genreChoice} Ongoing Recommendation: ${title}`)
                .setURL(anime.siteUrl || 'https://anilist.co')
                .setThumbnail(anime.coverImage?.large || null)
                .addFields(
                    { name: 'Episodes', value: `${anime.episodes ?? 'N/A'}`, inline: true },
                    { name: 'Status', value: anime.status || 'N/A', inline: true },
                    { name: 'Score', value: `⭐ ${score}`, inline: true }
                )
                .setDescription(cleanDesc)
                .setColor('#121212');

            const trackBtn = new ButtonBuilder()
                .setCustomId(`track_btn_${anime.id}`)
                .setLabel('🎯 Channel Track')
                .setStyle(ButtonStyle.Success);

            const favBtn = new ButtonBuilder()
                .setCustomId(`fav_btn_${anime.id}`)
                .setLabel('⭐ Favorite (DM Alert)')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(trackBtn, favBtn);

            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (err) {
            await interaction.editReply('Failed to fetch genre recommendations.');
        }
    }

    else if (commandName === 'character') {
        await interaction.deferReply({ ephemeral: true });
        const charName = interaction.options.getString('name');

        const gqlQuery = `
        query ($search: String) {
          Character (search: $search) {
            id
            name { full native }
            description(asHtml: false)
            image { large }
            siteUrl
          }
        }`;

        try {
            const data = await fetchAniList(gqlQuery, { search: charName });
            const char = data?.Character;

            if (!char) return interaction.editReply('Character not found!');

            const cleanDesc = char.description ? char.description.replace(/<[^>]*>?/gm, '').substring(0, 350) + '...' : 'No description available.';

            const embed = new EmbedBuilder()
                .setTitle(char.name.full + (char.name.native ? ` (${char.name.native})` : ''))
                .setURL(char.siteUrl)
                .setThumbnail(char.image?.large || null)
                .setDescription(cleanDesc)
                .setColor('#121212');

            const vaBtn = new ButtonBuilder()
                .setCustomId(`char_va_${char.id}`)
                .setLabel('🎙️ Voice Actor')
                .setStyle(ButtonStyle.Primary);

            const artBtn = new ButtonBuilder()
                .setCustomId(`char_art_${char.id}`)
                .setLabel('🎨 Fanart Gallery')
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(vaBtn, artBtn);

            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (err) {
            await interaction.editReply('Failed to fetch character details.');
        }
    }

    else if (commandName === 'report') {
        await interaction.deferReply({ ephemeral: true });
        const reportMsg = interaction.options.getString('message');

        try {
            const devUser = await client.users.fetch(DEV_USER_ID).catch(() => null);

            const devEmbed = new EmbedBuilder()
                .setTitle('📥 New Report Received!')
                .addFields(
                    { name: '👤 From User', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                    { name: '🏰 Context', value: interaction.guild ? interaction.guild.name : 'Direct Message / User Install', inline: true },
                    { name: '📝 Report Message', value: reportMsg }
                )
                .setColor('#e74c3c')
                .setTimestamp();

            if (devUser) await devUser.send({ embeds: [devEmbed] });

            await interaction.editReply({ content: '✅ Your report has been sent directly to the developer team! Thank you.' });
        } catch (err) {
            await interaction.editReply({ content: 'Failed to send report.' });
        }
    }

    else if (commandName === 'anime') {
        await interaction.deferReply({ ephemeral: true });
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

            const title = anime.title.english || anime.title.romaji || searchQuery;
            const cleanDesc = anime.description ? anime.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';
            const score = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : 'N/A';

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setURL(anime.siteUrl || 'https://anilist.co')
                .setThumbnail(anime.coverImage?.large || null)
                .addFields(
                    { name: 'Episodes', value: `${anime.episodes ?? 'N/A'}`, inline: true },
                    { name: 'Status', value: anime.status || 'N/A', inline: true },
                    { name: 'Score', value: `⭐ ${score}`, inline: true }
                )
                .setDescription(cleanDesc)
                .setColor('#121212');

            const trackBtn = new ButtonBuilder()
                .setCustomId(`track_btn_${anime.id}`)
                .setLabel('🎯 Channel Track')
                .setStyle(ButtonStyle.Success);

            const favBtn = new ButtonBuilder()
                .setCustomId(`fav_btn_${anime.id}`)
                .setLabel('⭐ Favorite (DM Alert)')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(trackBtn, favBtn);

            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (err) {
            await interaction.editReply('Failed to fetch anime data.');
        }
    }

    else if (commandName === 'manga') {
        await interaction.deferReply({ ephemeral: true });
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

            const title = manga.title.english || manga.title.romaji || searchQuery;
            const cleanDesc = manga.description ? manga.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';
            const score = manga.averageScore ? (manga.averageScore / 10).toFixed(1) : 'N/A';

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setURL(manga.siteUrl || 'https://anilist.co')
                .setThumbnail(manga.coverImage?.large || null)
                .addFields(
                    { name: 'Chapters', value: `${manga.chapters ?? 'N/A'}`, inline: true },
                    { name: 'Status', value: manga.status || 'N/A', inline: true },
                    { name: 'Score', value: `⭐ ${score}`, inline: true }
                )
                .setDescription(cleanDesc)
                .setColor('#121212');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch manga data.');
        }
    }

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

            if (!anime) return interaction.editReply('Anime not found!');

            const animeTitle = anime.title.english || anime.title.romaji || searchQuery;
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
            await interaction.editReply('Failed to add to personal favorites.');
        }
    }

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

            const animeTitle = anime.title.english || anime.title.romaji || searchQuery;
            const deleted = await FavoriteItem.findOneAndDelete({ userId: interaction.user.id, animeId: anime.id });

            if (!deleted) return interaction.editReply(`**${animeTitle}** was not in your favorites list.`);

            await interaction.editReply(`🗑️ Removed **${animeTitle}** from your personal favorites.`);
        } catch (err) {
            await interaction.editReply('Failed to remove from favorites.');
        }
    }

    else if (commandName === 'myfavorites') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const favorites = await FavoriteItem.find({ userId: interaction.user.id });
            if (favorites.length === 0) return interaction.editReply('You currently have no anime saved in your personal favorites.');

            const list = favorites.map((item, index) => `${index + 1}. **${item.animeTitle}**`).join('\n');
            const embed = new EmbedBuilder()
                .setTitle('⭐ Your Personal Favorite Anime List')
                .setDescription(list)
                .setColor('#121212')
                .setFooter({ text: 'You will receive Direct Messages when new episodes air!' });

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch favorites list.');
        }
    }

    else if (commandName === 'track') {
        await interaction.deferReply({ ephemeral: true });
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

            if (!anime) return interaction.editReply('Anime not found!');

            const animeTitle = anime.title.english || anime.title.romaji || searchQuery;

            const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: anime.id });
            if (existing) return interaction.editReply(`**${animeTitle}** is already being tracked in this server!`);

            await TrackedItem.create({
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                animeId: anime.id,
                animeTitle: animeTitle,
                lastEpisodes: anime.episodes || 0,
                lastStatus: anime.status || 'UNKNOWN'
            });

            const embed = new EmbedBuilder()
                .setTitle('🎯 Tracking Started!')
                .setDescription(`Now tracking **[${animeTitle}](${anime.siteUrl})** in this channel.\nYou will receive alerts here when new episodes release!`)
                .setThumbnail(anime.coverImage?.large || null)
                .setColor('#121212');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to track this anime.');
        }
    }

    else if (commandName === 'untrack') {
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

            const animeTitle = anime.title.english || anime.title.romaji || searchQuery;
            const deleted = await TrackedItem.findOneAndDelete({ guildId: interaction.guildId, animeId: anime.id });
            
            if (!deleted) return interaction.editReply(`**${animeTitle}** was not being tracked.`);

            await interaction.editReply(`🚨 Stopped tracking **${animeTitle}**.`);
        } catch (err) {
            await interaction.editReply('Failed to untrack.');
        }
    }

    else if (commandName === 'mytracked') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const items = await TrackedItem.find({ guildId: interaction.guildId });
            if (items.length === 0) return interaction.editReply('No anime is currently being tracked in this server.');

            const list = items.map((item, index) => `${index + 1}. **${item.animeTitle}** (Channel: <#${item.channelId}>)`).join('\n');
            const embed = new EmbedBuilder()
                .setTitle('📌 Tracked Anime List')
                .setDescription(list)
                .setColor('#121212');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch tracked list.');
        }
    }
});

// Automated Episode Checker
async function checkUpdates() {
    try {
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
                  }
                }`;

                const data = await fetchAniList(gqlQuery, { id: item.animeId });
                const anime = data?.Media;

                if (anime) {
                    const currentEps = anime.episodes || 0;
                    const lastEps = item.lastEpisodes || 0;
                    
                    if (currentEps > lastEps) {
                        const channel = await client.channels.fetch(item.channelId).catch(() => null);
                        if (channel) {
                            const animeTitle = anime.title.english || anime.title.romaji || item.animeTitle;

                            const embed = new EmbedBuilder()
                                .setTitle(`🚨 New Episode Released!`)
                                .setDescription(`Episode **${currentEps}** of **[${animeTitle}](${anime.siteUrl})** is now out!`)
                                .setThumbnail(anime.coverImage?.large || null)
                                .setColor('#121212');

                            await channel.send({ embeds: [embed] });
                        }

                        item.lastEpisodes = currentEps;
                        item.lastStatus = anime.status || 'UNKNOWN';
                        await item.save();
                    }
                }
            } catch (err) {
                console.error(`Error checking channel tracker for anime ID ${item.animeId}`);
            }
        }

        const favorites = await FavoriteItem.find({});
        for (const item of favorites) {
            try {
                const gqlQuery = `
                query ($id: Int) {
                  Media (id: $id, type: ANIME) {
                    id
                    title { romaji english }
                    episodes
                    coverImage { large }
                    siteUrl
                  }
                }`;

                const data = await fetchAniList(gqlQuery, { id: item.animeId });
                const anime = data?.Media;

                if (anime) {
                    const currentEps = anime.episodes || 0;
                    const lastEps = item.lastEpisodes || 0;

                    if (currentEps > lastEps) {
                        const user = await client.users.fetch(item.userId).catch(() => null);
                        if (user) {
                            const animeTitle = anime.title.english || anime.title.romaji || item.animeTitle;

                            const embed = new EmbedBuilder()
                                .setTitle(`⭐ New Episode Alert!`)
                                .setDescription(`Episode **${currentEps}** of **[${animeTitle}](${anime.siteUrl})** is now available!`)
                                .setThumbnail(anime.coverImage?.large || null)
                                .setColor('#121212');

                            await user.send({ embeds: [embed] }).catch(() => {});
                        }

                        item.lastEpisodes = currentEps;
                        await item.save();
                    }
                }
            } catch (err) {
                console.error(`Error checking DM favorite for anime ID ${item.animeId}`);
            }
        }
    } catch (err) {
        console.error('Error in background checkUpdates loop');
    }
}

client.login(process.env.DISCORD_TOKEN);
