const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'anime') {
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

            const title = anime.title.english || anime.title.romaji;
            const cleanDesc = anime.description ? anime.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setURL(anime.siteUrl)
                .setThumbnail(anime.coverImage.large)
                .addFields(
                    { name: 'Episodes', value: `${anime.episodes || 'N/A'}`, inline: true },
                    { name: 'Status', value: anime.status || 'N/A', inline: true },
                    { name: 'Score', value: anime.averageScore ? `${anime.averageScore} / 100` : 'N/A', inline: true }
                )
                .setDescription(cleanDesc)
                .setColor('#FF5733');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch anime data.');
        }
    } 
    
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

            const title = manga.title.english || manga.title.romaji;
            const cleanDesc = manga.description ? manga.description.replace(/<[^>]*>?/gm, '').substring(0, 300) + '...' : 'No synopsis available.';

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setURL(manga.siteUrl)
                .setThumbnail(manga.coverImage.large)
                .addFields(
                    { name: 'Chapters', value: `${manga.chapters || 'N/A'}`, inline: true },
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

            const animeTitle = anime.title.english || anime.title.romaji;

            const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: anime.id });
            if (existing) {
                return await interaction.editReply(`**${animeTitle}** is already being tracked in this server!`);
            }

            // تم تعديلها هنا عشان الأنميات المنتهية أو اللي مالهاش حلقات محددة تتسجل من غير مشاكل
            await TrackedItem.create({
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                animeId: anime.id,
                animeTitle: animeTitle,
                lastEpisodes: anime.episodes || 9999,
                lastStatus: anime.status
            });

            const embed = new EmbedBuilder()
                .setTitle('🎯 Tracking Started!')
                .setDescription(`Now tracking **[${animeTitle}](${anime.siteUrl})** in this channel.\nYou will receive alerts here when new episodes release!`)
                .setThumbnail(anime.coverImage.large)
                .setColor('#3498db');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('Track Command Error:', err.message);
            await interaction.editReply(`Failed to track this anime. Details: ${err.message}`);
        }
    }

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

            const animeTitle = anime.title.english || anime.title.romaji;
            const deleted = await TrackedItem.findOneAndDelete({ guildId: interaction.guildId, animeId: anime.id });
            
            if (!deleted) {
                return interaction.editReply(`**${animeTitle}** was not being tracked.`);
            }

            await interaction.editReply(`🚨 Stopped tracking **${animeTitle}**.`);
        } catch (err) {
            await interaction.editReply('Failed to untrack.');
        }
    }

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
                    if (currentEps > item.lastEpisodes) {
                        const channel = await client.channels.fetch(item.channelId).catch(() => null);
                        if (channel) {
                            const animeTitle = anime.title.english || anime.title.romaji;
                            const embed = new EmbedBuilder()
                                .setTitle(`🚨 New Episode Released!`)
                                .setDescription(`Episode **${currentEps}** of **[${animeTitle}](${anime.siteUrl})** is now available! 🎉`)
                                .setThumbnail(anime.coverImage.large)
                                .setColor('#e74c3c');

                            await channel.send({ embeds: [embed] });
                        }

                        item.lastEpisodes = currentEps;
                        item.lastStatus = anime.status;
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
