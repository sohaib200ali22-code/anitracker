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
} = require("discord.js");

const axios = require("axios");
const http = require("http");
const mongoose = require("mongoose");
require("dotenv").config();

// Required environment variables
const requiredEnv = ["DISCORD_TOKEN", "MONGODB_URI"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(", ")}`
  );
  process.exit(1);
}

if (!process.env.DEV_USER_ID) {
  console.warn("DEV_USER_ID is not set; /testalert will remain unavailable.");
}

// Keep-alive web server
const webServer = http.createServer((req, res) => {
  res.write("AniTracker is running!");
  res.end();
});

const webPort = Number(process.env.PORT) || 3000;

webServer.on("error", (err) => {
  console.error("Web server error:", err);
});

webServer.listen(webPort, () => {
  console.log(`Keep-alive server listening on port ${webPort}`);
});

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB Atlas!"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

// Tracked anime schema
const TrackSchema = new mongoose.Schema({
  guildId: String,
  channelId: String,
  animeId: Number,
  animeTitle: String,
  lastEpisodes: Number,
  lastStatus: String
});

const TrackedItem = mongoose.model("TrackedItem", TrackSchema);

// Favorite anime schema
const FavoriteSchema = new mongoose.Schema({
  userId: String,
  animeId: Number,
  animeTitle: String,
  lastEpisodes: Number
});

const FavoriteItem = mongoose.model("FavoriteItem", FavoriteSchema);

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Delay helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// AniList API helper
async function fetchAniList(query, variables) {
  const response = await axios.post(
    "https://graphql.anilist.co",
    {
      query,
      variables
    },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      timeout: 10000
    }
  );

  const payload = response.data;

  if (payload?.errors?.length) {
    const message = payload.errors
      .map((error) => error.message)
      .filter(Boolean)
      .join("; ");

    throw new Error(
      `AniList GraphQL error: ${message || "Unknown API error"}`
    );
  }

  if (!payload?.data) {
    throw new Error("AniList returned an empty response");
  }

  return payload.data;
}

// Get the number of episodes that actually aired
function getAiredEpisodes(anime) {
  if (anime.status === "RELEASING" && anime.nextAiringEpisode?.episode) {
    return Math.max(0, anime.nextAiringEpisode.episode - 1);
  }

  return anime.episodes || 0;
}

// Repair old records that stored the planned episode total
function hasLegacyEpisodeBaseline(anime, lastEpisodes, currentEpisodes) {
  return (
    anime.status === "RELEASING" &&
    Number.isFinite(anime.episodes) &&
    currentEpisodes < lastEpisodes &&
    lastEpisodes >= anime.episodes
  );
}

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Welcome guide, basic features, and support contact"),

  new SlashCommandBuilder()
    .setName("favorite")
    .setDescription(
      "Add an anime to your personal favorites and receive DM notifications"
    )
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Anime title to add to favorites")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("unfavorite")
    .setDescription("Remove an anime from your personal favorites")
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Anime title to remove from favorites")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("myfavorites")
    .setDescription("List all your personal favorite anime"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Displays a list of available commands"),

  new SlashCommandBuilder()
    .setName("anime")
    .setDescription("Search for an anime")
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Anime title")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("manga")
    .setDescription("Search for a manga")
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Manga title")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("character")
    .setDescription("Search for an anime character")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Character name")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("genre")
    .setDescription("Find a highly-rated anime by genre")
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription("Choose a genre")
        .setRequired(true)
        .addChoices(
          { name: "Action", value: "Action" },
          { name: "Adventure", value: "Adventure" },
          { name: "Comedy", value: "Comedy" },
          { name: "Fantasy", value: "Fantasy" },
          { name: "Romance", value: "Romance" },
          { name: "Sci-Fi", value: "Sci-Fi" },
          { name: "Horror", value: "Horror" },
          { name: "Sports", value: "Sports" },
          { name: "Slice of Life", value: "Slice of Life" }
        )
    ),

  new SlashCommandBuilder()
    .setName("track")
    .setDescription("Track an anime for new episode updates in this channel")
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Anime title to track")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("untrack")
    .setDescription("Stop tracking an anime in this channel")
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Anime title to untrack")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("mytracked")
    .setDescription("List all tracked anime in this server"),

  new SlashCommandBuilder()
    .setName("testalert")
    .setDescription("(Dev only) Run the episode alert check now")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map((command) => command.toJSON());

// Bot ready event
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  client.user.setActivity("AniList for new episodes", {
    type: ActivityType.Watching
  });

  client.user.setStatus("online");

  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_TOKEN
  );

  try {
    console.log("Started refreshing application commands.");

    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands
    });

    console.log("Successfully reloaded application commands!");
  } catch (error) {
    console.error("Error registering commands:", error);
  }

  setInterval(checkUpdates, 30 * 60 * 1000);
});

// Interaction handler
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("track_btn_")) {
        if (!interaction.guildId) {
          return interaction.reply({
            content:
              "Channel tracking works inside a server. Use `/favorite <title>` for personal DM alerts.",
            ephemeral: true
          });
        }

        await interaction.deferReply({ ephemeral: true });

        const animeId = parseInt(
          interaction.customId.replace("track_btn_", ""),
          10
        );

        const gqlQuery = `
          query ($id: Int) {
            Media (id: $id, type: ANIME) {
              id
              title { romaji english }
              episodes
              status
              siteUrl
              nextAiringEpisode { episode }
            }
          }
        `;

        try {
          const data = await fetchAniList(gqlQuery, { id: animeId });
          const anime = data?.Media;

          if (!anime) {
            return interaction.editReply({
              content: "Anime not found!"
            });
          }

          const animeTitle =
            anime.title?.english ||
            anime.title?.romaji ||
            "Unknown Anime";

          const existing = await TrackedItem.findOne({
            guildId: interaction.guildId,
            animeId: anime.id
          });

          if (existing) {
            return interaction.editReply({
              content: `**${animeTitle}** is already tracked in this server!`
            });
          }

          await TrackedItem.create({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            animeId: anime.id,
            animeTitle,
            lastEpisodes: getAiredEpisodes(anime),
            lastStatus: anime.status || "UNKNOWN"
          });

          return interaction.editReply({
            content: `Successfully started tracking **[${animeTitle}](${
              anime.siteUrl || "https://anilist.co"
            })** in this channel!`
          });
        } catch (err) {
          console.error("Track button error:", err);

          return interaction.editReply({
            content: "Failed to track anime."
          });
        }
      }

      if (interaction.customId.startsWith("fav_btn_")) {
        await interaction.deferReply({ ephemeral: true });

        const animeId = parseInt(
          interaction.customId.replace("fav_btn_", ""),
          10
        );

        const gqlQuery = `
          query ($id: Int) {
            Media (id: $id, type: ANIME) {
              id
              title { romaji english }
              episodes
              status
              siteUrl
              nextAiringEpisode { episode }
            }
          }
        `;

        try {
          const data = await fetchAniList(gqlQuery, { id: animeId });
          const anime = data?.Media;

          if (!anime) {
            return interaction.editReply({
              content: "Anime not found!"
            });
          }

          const animeTitle =
            anime.title?.english ||
            anime.title?.romaji ||
            "Unknown Anime";

          const existing = await FavoriteItem.findOne({
            userId: interaction.user.id,
            animeId: anime.id
          });

          if (existing) {
            return interaction.editReply({
              content: `**${animeTitle}** is already in your personal favorites!`
            });
          }

          await FavoriteItem.create({
            userId: interaction.user.id,
            animeId: anime.id,
            animeTitle,
            lastEpisodes: getAiredEpisodes(anime)
          });

          return interaction.editReply({
            content: `Added **[${animeTitle}](${
              anime.siteUrl || "https://anilist.co"
            })** to your personal favorites!`
          });
        } catch (err) {
          console.error("Favorite button error:", err);

          return interaction.editReply({
            content: "Failed to add favorite."
          });
        }
      }

      if (interaction.customId.startsWith("char_info_")) {
        await interaction.deferReply({ ephemeral: true });

        const charId = parseInt(
          interaction.customId.replace("char_info_", ""),
          10
        );

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
          }
        `;

        try {
          const data = await fetchAniList(gqlQuery, { id: charId });
          const character = data?.Character;

          if (!character) {
            return interaction.editReply({
              content: "Character not found!"
            });
          }

          const alternativeNames =
            character.name?.alternative?.filter(Boolean).join(", ") || "N/A";

          const dateOfBirth =
            character.dateOfBirth &&
            (character.dateOfBirth.month || character.dateOfBirth.day)
              ? `${character.dateOfBirth.month ?? "?"}/${
                  character.dateOfBirth.day ?? "?"
                }`
              : "N/A";

          let description = character.description
            ? character.description
                .replace(/~!/g, "||")
                .replace(/!~/g, "||")
                .replace(/<[^>]*>/gm, "")
            : "No description available.";

          if (description.length > 4000) {
            description = `${description.substring(0, 3997)}...`;
          }

          const appearsIn =
            character.media?.edges
              ?.map(
                (edge) =>
                  edge.node?.title?.english || edge.node?.title?.romaji
              )
              .filter(Boolean)
              .slice(0, 5)
              .join("\n") || "N/A";

          const voiceActor =
            character.media?.edges?.find(
              (edge) => edge.voiceActors?.[0]?.name?.full
            )?.voiceActors?.[0]?.name?.full || "N/A";

          const embed = new EmbedBuilder()
            .setTitle(
              `${character.name?.full || "Unknown"} — More Information`
            )
            .setURL(character.siteUrl || "https://anilist.co")
            .setDescription(description)
            .setThumbnail(
              character.image?.large ||
                "https://i.imgur.com/AGv4yDI.png"
            )
            .addFields(
              {
                name: "Native Name",
                value: character.name?.native || "N/A",
                inline: true
              },
              {
                name: "Gender",
                value: character.gender || "N/A",
                inline: true
              },
              {
                name: "Age",
                value: `${character.age ?? "N/A"}`,
                inline: true
              },
              {
                name: "Date of Birth",
                value: dateOfBirth,
                inline: true
              },
              {
                name: "Favorites",
                value: `${character.favourites?.toLocaleString?.() || 0}`,
                inline: true
              },
              {
                name: "Voice Actor (JP)",
                value: voiceActor,
                inline: true
              },
              {
                name: "Appears In",
                value: appearsIn,
                inline: false
              },
              {
                name: "Alternative Names",
                value: alternativeNames,
                inline: false
              }
            )
            .setColor("#9b59b6");

          return interaction.editReply({
            embeds: [embed]
          });
        } catch (err) {
          console.error("Character info button error:", err);

          return interaction.editReply({
            content: "Failed to fetch character information."
          });
        }
      }

      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const { commandName } = interaction;

    if (commandName === "start") {
      const embed = new EmbedBuilder()
        .setTitle("Welcome to AniTracker!")
        .setDescription(
          "Your Discord companion for anime search, recommendations, and automatic episode notifications."
        )
        .addFields(
          {
            name: "What can AniTracker do?",
            value:
              "• Search anime and manga details.\n• Track anime in server channels.\n• Add anime to personal favorites.\n• Receive notifications when new episodes release."
          },
          {
            name: "Quick Start Commands",
            value:
              "`/anime` - Search anime\n`/genre` - Discover anime by genre\n`/track` - Track anime in a channel\n`/favorite <title>` - Add a personal favorite\n`/help` - Show all commands"
          },
          {
            name: "Support",
            value:
              "For bugs or feature requests, visit the support server."
          }
        )
        .setColor("#2ecc71")
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({
          text: "AniTracker • Developed for Anime Lovers"
        });

      const supportButton = new ButtonBuilder()
        .setLabel("Support Server")
        .setStyle(ButtonStyle.Link)
        .setURL("https://discord.gg/H4Af2y4RD8");

      const row = new ActionRowBuilder().addComponents(supportButton);

      try {
        await interaction.user.send({
          embeds: [embed],
          components: [row]
        });

        return interaction.reply({
          content: "Check your Direct Messages!",
          ephemeral: true
        });
      } catch {
        return interaction.reply({
          content:
            "Could not send you a DM. Please enable Direct Messages.",
          embeds: [embed],
          components: [row],
          ephemeral: true
        });
      }
    }

    if (commandName === "character") {
      const characterName = interaction.options.getString("name");

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
        }
      `;

      try {
        const data = await fetchAniList(gqlQuery, {
          search: characterName
        });

        const character = data?.Character;

        if (!character) {
          return interaction.editReply(
            `No character found with the name **"${characterName}"**.`
          );
        }

        const fullName = character.name?.full || characterName;
        const nativeName = character.name?.native
          ? ` (${character.name.native})`
          : "";

        const animeSource =
          character.media?.edges?.[0]?.node?.title?.english ||
          character.media?.edges?.[0]?.node?.title?.romaji ||
          "Unknown Anime";

        let description = character.description
          ? character.description
              .replace(/~!/g, "||")
              .replace(/!~/g, "||")
              .replace(/<[^>]*>/gm, "")
          : "No description available.";

        if (description.length > 350) {
          description = `${description.substring(0, 347)}...`;
        }

        const embed = new EmbedBuilder()
          .setTitle(`${fullName}${nativeName}`)
          .setURL(character.siteUrl || "https://anilist.co")
          .setDescription(description)
          .addFields(
            {
              name: "From Anime",
              value: animeSource,
              inline: true
            },
            {
              name: "Favorites",
              value: `${character.favourites?.toLocaleString?.() || 0}`,
              inline: true
            }
          )
          .setImage(
            character.image?.large ||
              "https://i.imgur.com/AGv4yDI.png"
          )
          .setColor("#9b59b6")
          .setFooter({
            text: "AniTracker • Character Search"
          });

        const infoButton = new ButtonBuilder()
          .setCustomId(`char_info_${character.id}`)
          .setLabel("More Information")
          .setStyle(ButtonStyle.Primary);

        const pinterestLink = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(
          `${fullName} anime fanart`
        )}`;

        const fanartButton = new ButtonBuilder()
          .setLabel("Fanart")
          .setStyle(ButtonStyle.Link)
          .setURL(pinterestLink);

        const row = new ActionRowBuilder().addComponents(
          infoButton,
          fanartButton
        );

        return interaction.editReply({
          embeds: [embed],
          components: [row]
        });
      } catch (err) {
        console.error("Character command error:", err);

        return interaction.editReply({
          content: "Failed to fetch character data."
        });
      }
    }

    if (commandName === "favorite") {
      await interaction.deferReply({ ephemeral: true });

      const searchQuery = interaction.options.getString("title");

      const gqlQuery = `
        query ($search: String) {
          Media (search: $search, type: ANIME) {
            id
            title { romaji english }
            episodes
            status
            siteUrl
            nextAiringEpisode { episode }
          }
        }
      `;

      try {
        const data = await fetchAniList(gqlQuery, {
          search: searchQuery
        });

        const anime = data?.Media;

        if (!anime) {
          return interaction.editReply(
            "Anime not found. Please check the title and try again."
          );
        }

        const animeTitle =
          anime.title?.english ||
          anime.title?.romaji ||
          searchQuery;

        const existing = await FavoriteItem.findOne({
          userId: interaction.user.id,
          animeId: anime.id
        });

        if (existing) {
          return interaction.editReply(
            `**${animeTitle}** is already in your personal favorites!`
          );
        }

        await FavoriteItem.create({
          userId: interaction.user.id,
          animeId: anime.id,
          animeTitle,
          lastEpisodes: getAiredEpisodes(anime)
        });

        return interaction.editReply(
          `Added **[${animeTitle}](${
            anime.siteUrl || "https://anilist.co"
          })** to your personal favorites!`
        );
      } catch (err) {
        console.error("Favorite command error:", err);

        return interaction.editReply({
          content: "Failed to add anime to your favorites."
        });
      }
    }

    if (commandName === "unfavorite") {
      await interaction.deferReply({ ephemeral: true });

      const searchQuery = interaction.options.getString("title");

      const gqlQuery = `
        query ($search: String) {
          Media (search: $search, type: ANIME) {
            id
            title { romaji english }
          }
        }
      `;

      try {
        const data = await fetchAniList(gqlQuery, {
          search: searchQuery
        });

        const anime = data?.Media;

        if (!anime) {
          return interaction.editReply("Anime not found!");
        }

        const animeTitle =
          anime.title?.english ||
          anime.title?.romaji ||
          searchQuery;

        const deleted = await FavoriteItem.findOneAndDelete({
          userId: interaction.user.id,
          animeId: anime.id
        });

        if (!deleted) {
          return interaction.editReply(
            `**${animeTitle}** was not in your favorites list.`
          );
        }

        return interaction.editReply(
          `Removed **${animeTitle}** from your personal favorites.`
        );
      } catch (err) {
        console.error("Unfavorite command error:", err);

        return interaction.editReply({
          content: "Failed to remove anime from favorites."
        });
      }
    }

    if (commandName === "myfavorites") {
      await interaction.deferReply({ ephemeral: true });

      try {
        const favorites = await FavoriteItem.find({
          userId: interaction.user.id
        });

        if (favorites.length === 0) {
          return interaction.editReply(
            "You currently have no anime saved in your favorites."
          );
        }

        const visibleFavorites = favorites.slice(0, 25);

        const list = visibleFavorites
          .map(
            (item, index) =>
              `${index + 1}. **${item.animeTitle}**`
          )
          .join("\n");

        const moreMessage =
          favorites.length > visibleFavorites.length
            ? `\n\n…and ${
                favorites.length - visibleFavorites.length
              } more.`
            : "";

        const embed = new EmbedBuilder()
          .setTitle("Your Personal Favorite Anime")
          .setDescription(`${list}${moreMessage}`)
          .setColor("#f39c12")
          .setFooter({
            text: "You will receive DMs when new episodes air!"
          });

        return interaction.editReply({
          embeds: [embed]
        });
      } catch (err) {
        console.error("My favorites error:", err);

        return interaction.editReply({
          content: "Failed to fetch your favorites list."
        });
      }
    }

    if (commandName === "help") {
      const embed = new EmbedBuilder()
        .setTitle("AniTracker Commands Guide")
        .setDescription(
          "Here is the full list of available slash commands:"
        )
        .addFields(
          {
            name: "/start",
            value: "Show the welcome guide.",
            inline: false
          },
          {
            name: "/favorite <title>",
            value: "Add anime to your personal favorites.",
            inline: false
          },
          {
            name: "/unfavorite <title>",
            value: "Remove anime from your favorites.",
            inline: false
          },
          {
            name: "/myfavorites",
            value: "Show your personal favorite anime.",
            inline: false
          },
          {
            name: "/anime <title>",
            value: "Search for an anime.",
            inline: false
          },
          {
            name: "/manga <title>",
            value: "Search for a manga.",
            inline: false
          },
          {
            name: "/character <name>",
            value: "Search for an anime character.",
            inline: false
          },
          {
            name: "/genre <category>",
            value: "Find a currently airing anime by genre.",
            inline: false
          },
          {
            name: "/track <title>",
            value: "Track anime in the current server channel.",
            inline: false
          },
          {
            name: "/untrack <title>",
            value: "Stop tracking anime in the current server.",
            inline: false
          },
          {
            name: "/mytracked",
            value: "Show tracked anime in the current server.",
            inline: false
          }
        )
        .setColor("#9b59b6")
        .setFooter({
          text: "AniTracker • Anime tracking and notifications"
        });

      const supportButton = new ButtonBuilder()
        .setLabel("Support Server")
        .setStyle(ButtonStyle.Link)
        .setURL("https://discord.gg/H4Af2y4RD8");

      const profileButton = new ButtonBuilder()
        .setLabel("Developer Profile")
        .setStyle(ButtonStyle.Link)
        .setURL(
          "https://discord.com/users/1326815636395003966"
        );

      const row = new ActionRowBuilder().addComponents(
        supportButton,
        profileButton
      );

      return interaction.reply({
        embeds: [embed],
        components: [row],
        ephemeral: true
      });
    }

    if (commandName === "anime") {
      await interaction.deferReply();

      const searchQuery = interaction.options.getString("title");

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
        }
      `;

      try {
        const data = await fetchAniList(gqlQuery, {
          search: searchQuery
        });

        const anime = data?.Media;

        if (!anime) {
          return interaction.editReply("Anime not found!");
        }

        const title =
          anime.title?.english ||
          anime.title?.romaji ||
          searchQuery;

        let description = anime.description
          ? anime.description.replace(/<[^>]*>?/gm, "")
          : "No synopsis available.";

        if (description.length > 300) {
          description = `${description.substring(0, 297)}...`;
        }

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setURL(anime.siteUrl || "https://anilist.co")
          .setThumbnail(
            anime.coverImage?.large ||
              "https://i.imgur.com/AGv4yDI.png"
          )
          .addFields(
            {
              name: "Episodes",
              value: `${anime.episodes ?? "N/A"}`,
              inline: true
            },
            {
              name: "Status",
              value: anime.status || "N/A",
              inline: true
            },
            {
              name: "Score",
              value: anime.averageScore
                ? `${anime.averageScore} / 100`
                : "N/A",
              inline: true
            }
          )
          .setDescription(description)
          .setColor("#ff5733");

        const trackButton = new ButtonBuilder()
          .setCustomId(`track_btn_${anime.id}`)
          .setLabel("Channel Track")
          .setStyle(ButtonStyle.Success);

        const favoriteButton = new ButtonBuilder()
          .setCustomId(`fav_btn_${anime.id}`)
          .setLabel("Favorite DM Alert")
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(
          trackButton,
          favoriteButton
        );

        return interaction.editReply({
          embeds: [embed],
          components: [row]
        });
      } catch (err) {
        console.error("Anime command error:", err);

        return interaction.editReply({
          content: "Failed to fetch anime data."
        });
      }
    }

    if (commandName === "manga") {
      await interaction.deferReply();

      const searchQuery = interaction.options.getString("title");

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
        }
      `;

      try {
        const data = await fetchAniList(gqlQuery, {
          search: searchQuery
        });

        const manga = data?.Media;

        if (!manga) {
          return interaction.editReply("Manga not found!");
        }

        const title =
          manga.title?.english ||
          manga.title?.romaji ||
          searchQuery;

        let description = manga.description
          ? manga.description.replace(/<[^>]*>?/gm, "")
          : "No synopsis available.";

        if (description.length > 300) {
          description = `${description.substring(0, 297)}...`;
        }

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setURL(manga.siteUrl || "https://anilist.co")
          .setThumbnail(
            manga.coverImage?.large || **…**

_This response is too long to display in full._
