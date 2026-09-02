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
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('Slash commands registered successfully!');
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
        const query = interaction.options.getString('title');
        try {
            const res = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`);
            const anime = res.data.data[0];
            if (!anime) return interaction.editReply('Anime not found!');

            const embed = new EmbedBuilder()
                .setTitle(anime.title)
                .setURL(anime.url)
                .setThumbnail(anime.images.jpg.image_url)
                .addFields(
                    { name: 'Episodes', value: `${anime.episodes || 'N/A'}`, inline: true },
                    { name: 'Status', value: anime.status || 'N/A', inline: true },
                    { name: 'Score', value: `${anime.score || 'N/A'}`, inline: true }
                )
                .setDescription(anime.synopsis ? anime.synopsis.substring(0, 300) + '...' : 'No synopsis available.')
                .setColor('#FF5733');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch anime data.');
        }
    } 
    
    else if (commandName === 'manga') {
        await interaction.deferReply();
        const query = interaction.options.getString('title');
        try {
            const res = await axios.get(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(query)}&limit=1`);
            const manga = res.data.data[0];
            if (!manga) return interaction.editReply('Manga not found!');

            const embed = new EmbedBuilder()
                .setTitle(manga.title)
                .setURL(manga.url)
                .setThumbnail(manga.images.jpg.image_url)
                .addFields(
                    { name: 'Chapters', value: `${manga.chapters || 'N/A'}`, inline: true },
                    { name: 'Status', value: manga.status || 'N/A', inline: true },
                    { name: 'Score', value: `${manga.score || 'N/A'}`, inline: true }
                )
                .setDescription(manga.synopsis ? manga.synopsis.substring(0, 300) + '...' : 'No synopsis available.')
                .setColor('#33FF57');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to fetch manga data.');
        }
    }

    else if (commandName === 'track') {
        await interaction.deferReply();
        const query = interaction.options.getString('title');
        try {
            const res = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`);
            const anime = res.data.data[0];
            if (!anime) return interaction.editReply('Anime not found!');

            const existing = await TrackedItem.findOne({ guildId: interaction.guildId, animeId: anime.mal_id });
            if (existing) {
                return interaction.editReply(`**${anime.title}** is already being tracked in this server!`);
            }

            await TrackedItem.create({
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                animeId: anime.mal_id,
                animeTitle: anime.title,
                lastEpisodes: anime.episodes || 0,
                lastStatus: anime.status
            });

            const embed = new EmbedBuilder()
                .setTitle('🎯 Tracking Started!')
                .setDescription(`Now tracking **[${anime.title}](${anime.url})** in this channel.\nYou will receive alerts here when new episodes release!`)
                .setThumbnail(anime.images.jpg.image_url)
                .setColor('#3498db');

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('Failed to track this anime.');
        }
    }

    else if (commandName === 'untrack') {
        await interaction.deferReply();
        const query = interaction.options.getString('title');
        try {
            const res = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`);
            const anime = res.data.data[0];
            if (!anime) return interaction.editReply('Anime not found!');

            const deleted = await TrackedItem.findOneAndDelete({ guildId: interaction.guildId, animeId: anime.mal_id });
            if (!deleted) {
                return interaction.editReply(`**${anime.title}** was not being tracked.`);
            }

            await interaction.editReply(`🚨 Stopped tracking **${anime.title}**.`);
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
                const res = await axios.get(`https://api.jikan.moe/v4/anime/${item.animeId}`);
                const anime = res.data.data;

                if (anime) {
                    const currentEps = anime.episodes || 0;
                    if (currentEps > item.lastEpisodes) {
                        const channel = await client.channels.fetch(item.channelId).catch(() => null);
                        if (channel) {
                            const embed = new EmbedBuilder()
                                .setTitle(`🚨 New Episode Released!`)
                                .setDescription(`Episode **${currentEps}** of **[${anime.title}](${anime.url})** is now available! 🎉`)
                                .setThumbnail(anime.images.jpg.image_url)
                                .setColor('#e74c3c');

                            await channel.send({ embeds: [embed] });
                        }

                        item.lastEpisodes = currentEps;
                        item.lastStatus = anime.status;
                        await item.save();
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (err) {
                console.error(`Error checking update for anime ID ${item.animeId}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Error in tracker loop:', err);
    }
}

client.login(process.env.DISCORD_TOKEN);
