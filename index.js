const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('AniTracker is Live!'));
app.listen(port, () => console.log(`Server running on port ${port}`));require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// تعريف أوامر السلاش (أنمي ومانجا)
const commands = [
  new SlashCommandBuilder()
    .setName('anime')
    .setDescription('Search for any anime and get its details!')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('The name of the anime you want to search for')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('manga')
    .setDescription('Search for any manga and get its details!')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('The name of the manga you want to search for')
        .setRequired(true)
    ),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`🤖 Bot is online and logged in as: ${client.user.tag}`);

  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // أمر الأنمي
  if (interaction.commandName === 'anime') {
    const animeName = interaction.options.getString('title');
    await interaction.deferReply();

    try {
      const response = await axios.get(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(animeName)}&page[limit]=1`);
      const anime = response.data.data[0];

      if (!anime) {
        return interaction.editReply('No results found for the requested anime. Please verify the title and try again.');
      }

      const attr = anime.attributes;
      const animeTitle = attr.canonicalTitle || attr.en || 'N/A';
      const animeScore = attr.averageRating ? `${(attr.averageRating / 10).toFixed(1)} / 10` : 'N/A';
      const animeEpisodes = attr.episodeCount || 'Ongoing';
      const animeStatus = attr.status || 'N/A';
      const animePoster = attr.posterImage?.original || null;
      const animeLink = `https://kitsu.io/anime/${attr.slug}`;

      const animeEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🎬 ${animeTitle}`)
        .setURL(animeLink)
        .addFields(
          { name: '⭐ Score', value: animeScore, inline: true },
          { name: '📺 Episodes', value: String(animeEpisodes), inline: true },
          { name: '📌 Status', value: animeStatus, inline: true }
        )
        .setTimestamp();

      if (animePoster) {
        animeEmbed.setImage(animePoster);
      }

      await interaction.editReply({ embeds: [animeEmbed] });
    } catch (error) {
      console.error(error);
      await interaction.editReply('An error occurred while retrieving the anime details. Please try again later.');
    }
  }

  // أمر المانجا الجديد
  if (interaction.commandName === 'manga') {
    const mangaName = interaction.options.getString('title');
    await interaction.deferReply();

    try {
      const response = await axios.get(`https://kitsu.io/api/edge/manga?filter[text]=${encodeURIComponent(mangaName)}&page[limit]=1`);
      const manga = response.data.data[0];

      if (!manga) {
        return interaction.editReply('No results found for the requested manga. Please verify the title and try again.');
      }

      const attr = manga.attributes;
      const mangaTitle = attr.canonicalTitle || attr.en || 'N/A';
      const mangaScore = attr.averageRating ? `${(attr.averageRating / 10).toFixed(1)} / 10` : 'N/A';
      const mangaChapters = attr.chapterCount ? String(attr.chapterCount) : 'Ongoing';
      const mangaStatus = attr.status || 'N/A';
      const mangaPoster = attr.posterImage?.original || null;
      const mangaLink = `https://kitsu.io/manga/${attr.slug}`;

      const mangaEmbed = new EmbedBuilder()
        .setColor(0x9b59b6) // لون بنفسجي فخم للمانجا يليق بالستايل
        .setTitle(`📖 ${mangaTitle}`)
        .setURL(mangaLink)
        .addFields(
          { name: '⭐ Score', value: mangaScore, inline: true },
          { name: '📚 Chapters', value: mangaChapters, inline: true },
          { name: '📌 Status', value: mangaStatus, inline: true }
        )
        .setTimestamp();

      if (mangaPoster) {
        mangaEmbed.setImage(mangaPoster);
      }

      await interaction.editReply({ embeds: [mangaEmbed] });
    } catch (error) {
      console.error(error);
      await interaction.editReply('An error occurred while retrieving the manga details. Please try again later.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
