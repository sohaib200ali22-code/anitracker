const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } = require('discord.js');
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

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences
    ] 
});

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
        .setDescription('Find a highly-rated anime by genre')
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
        .setDescription('List all tracked anime in this server')
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
    // 🔘 Handle Interactive Buttons
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('track_btn_')) {
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
                { name: '📚 Quick Start Commands', value: '`/anime` - Search any anime\n`/genre` - Discover by genre\n`/track` - Track in channel\n`/favorite <title>` - Track in DMs\n`/help` - Show full commands list' },
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
            const animeSource = char.media?.nodes?.[0]?.title?.english || char.media?.nodes?.[0]?.title?.romaji || 'Unknown Anime';
            
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

            const pinterestUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(nameFull + ' anime fanart')}`;
            const fanartBtn = new ButtonBuilder()
                .setLabel('🎨 Fanart')
                .setStyle(ButtonStyle.Link)
                .setURL(pinterestUrl);

            const row = new ActionRowBuilder
// زرار More Info التفاعلي
            const infoBtn = new ButtonBuilder()
                .setCustomId(`char_info_${char.id}`)
                .setLabel('📖 More Info')
                .setStyle(ButtonStyle.Primary);

            const pinterestUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(nameFull + ' anime fanart')}`;
            const fanartBtn = new ButtonBuilder()
                .setLabel('🎨 Fanart')
                .setStyle(ButtonStyle.Link)
                .setURL(pinterestUrl);

            const row = new ActionRowBuilder().addComponents(infoBtn, fanartBtn);

            await interaction.editReply({ embeds: [embed], components: [row] });

        } catch (error) {
            console.error(error);
            await interaction.editReply('⚠️ An error occurred while fetching character details. Please try again later.');
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
                { name: '🎲 `/genre <category>`', value: 'Find top-rated anime filtered by genre.', inline: false },
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

        await interaction.reply({ embeds: [embed], components: [row] });
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

            const row = new ActionRowBuilder().addComponents(trackBtn, favBtn);

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
        await interaction.deferReply();
        const genreChoice = interaction.options.getString('category');

        const gqlQuery = `
        query ($genre: String) {
          Page (page: 1, perPage: 10) {
            media (genre: $genre, type: ANIME, sort: SCORE_DESC) {
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
                return interaction.editReply(`No anime found for genre: ${genreChoice}`);
            }

            const anime = mediaList[Math.floor(Math.random() * mediaList.length)];
            const title = (anime.title && (anime.title.english || anime.title.romaji)) || 'Anime Title';
            const cleanDesc = anime.description ? anime.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';

            const embed = new EmbedBuilder()
                .setTitle(`🎭 ${genreChoice} Recommendation: ${title}`)
                .setURL(anime.siteUrl || 'https://anilist.co')
                .setThumbnail(anime.coverImage?.large || 'https://i.imgur.com/AGv4yDI.png')
                .addFields(
                    { name: 'Episodes', value: `${anime.episodes ?? 'N/A'}`, inline: true },
                    { name: 'Status', value: anime.status || 'N/A', inline: true },
                    { name: 'Score', value: anime.averageScore ? `${anime.averageScore} / 100` : 'N/A', inline: true }
                )
                .setDescription(cleanDesc)
                .setColor('#1abc9c');

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

    // 🎯 Track Command
    else if (commandName === 'track') {
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
});

// Automated Episode Checker Function
async function checkUpdates() {
    try {
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
        }

        // 2. Check Personal Favorites (DM Alerts)
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
        }
    } catch (err) {
        console.error('Error in checkUpdates loop:', err);
    }
}

// Log in to Discord
client.login(process.env.DISCORD_TOKEN);
