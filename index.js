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

// MongoDB Schema for Tracked Items
const TrackSchema = new mongoose.Schema({
    guildId: String,
    channelId: String,
    animeId: Number,
    animeTitle: String,
    lastEpisodes: Number,
    lastStatus: String
});
const TrackedItem = mongoose.model('TrackedItem', TrackSchema);

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

    // Set Custom Status Activity
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
    // Handle Interactive Buttons
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
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // Help Command
    if (commandName === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('🤖 AniTracker - Commands Guide')
            .setDescription('Welcome to **AniTracker**! Here is the list of all available slash commands:')
            .addFields(
                { name: '🔍 `/anime <title>`', value: 'Search for anime details & quick track with a button.', inline: false },
                { name: '📖 `/manga <title>`', value: 'Search for manga details.', inline: false },
                { name: '🎭 `/genre <category>`', value: 'Find top-rated anime filtered by genre.', inline: false },
                { name: '🎯 `/track <title>`', value: 'Start tracking an anime for episode release notifications in this channel.', inline: false },
                { name: '🛑 `/untrack <title>`', value: 'Stop tracking an anime in this server.', inline: false },
                { name: '📌 `/mytracked`', value: 'Show all anime currently tracked in this server.', inline: false }
            )
            .setColor('#9b59b6')
            .setFooter({ text: 'AniTracker • Powered by AniList API' });

        await interaction.reply({ embeds: [embed] });
    }

    // Anime Search Command
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

            // Quick Track Button
            const trackBtn = new ButtonBuilder()
                .setCustomId(`track_btn_${anime.id}`)
                .setLabel('🎯 Track This Anime')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(trackBtn);

            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (err) {
            await interaction.editReply('Failed to fetch anime data.');
        }
    } 
    
    // Manga Search Command
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

    // Genre Search Command
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

            // Pick a random top anime from the genre list
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
                .setLabel('🎯 Track This Anime')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(trackBtn);

            await interaction.editReply({ embeds: [embed], components: [row] });
        } catch (err) {
            await interaction.editReply('Failed to fetch genre recommendations.');
        }
    }

    // Track Command
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

    // Untrack Command
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

    // List Tracked Command
    else if (commandName === 'mytracked') {
        await interaction.deferReply();
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
                                .setTitle(`🚨 New Episode Released!`)
                                .setDescription(`Episode **${currentEps}** of **[${animeTitle}](${siteUrl})** is now available! 🎉`)
                                .setThumbnail(coverUrl)
                                .setColor('#e74c3c');

                            await channel.send({ embeds: [embed] });
                        }

                        item.lastEpisodes = currentEps;
                        item.lastStatus = anime.status || 'UNKNOWN';
                        await item.save();
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
                console.error(`Error checking update for anime ID ${item.animeId}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Error in tracker loop:', err);
    }
}

client.login(process.env.DISCORD_TOKEN);
