const axios = require('axios');

// Create an Axios instance with custom User-Agent to prevent Jikan/Cloudflare blocks
const jikanClient = axios.create({
    headers: {
        'User-Agent': 'AniTrackerDiscordBot/1.0 (https://github.com)'
    },
    timeout: 8000
});

// 1. Search Anime
async function getAnimeJikan(title) {
    try {
        const res = await jikanClient.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`);
        const anime = res.data?.data?.[0];
        if (!anime) return null;

        return {
            title: anime.title_english || anime.title,
            episodes: anime.episodes || 'N/A',
            status: anime.status || 'N/A',
            score: anime.score || 'N/A',
            image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url,
            url: anime.url,
            synopsis: anime.synopsis ? anime.synopsis.slice(0, 300) + '...' : 'No description available.'
        };
    } catch (e) {
        console.error('Jikan Anime Fetch Error:', e.response?.status || e.message);
        return null;
    }
}

// 2. Search Manga
async function getMangaJikan(title) {
    try {
        const res = await jikanClient.get(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(title)}&limit=1`);
        const manga = res.data?.data?.[0];
        if (!manga) return null;

        return {
            title: manga.title_english || manga.title,
            chapters: manga.chapters || 'N/A',
            status: manga.status || 'N/A',
            score: manga.score || 'N/A',
            image: manga.images?.jpg?.large_image_url || manga.images?.jpg?.image_url,
            url: manga.url,
            synopsis: manga.synopsis ? manga.synopsis.slice(0, 300) + '...' : 'No description available.'
        };
    } catch (e) {
        console.error('Jikan Manga Fetch Error:', e.response?.status || e.message);
        return null;
    }
}

// 3. Search Character
async function getCharacterJikan(name) {
    try {
        const res = await jikanClient.get(`https://api.jikan.moe/v4/characters?q=${encodeURIComponent(name)}&limit=1`);
        const char = res.data?.data?.[0];
        if (!char) return null;

        return {
            name: char.name,
            image: char.images?.jpg?.image_url,
            about: char.about ? char.about.slice(0, 300) + '...' : 'No biography available.',
            url: char.url
        };
    } catch (e) {
        console.error('Jikan Character Fetch Error:', e.response?.status || e.message);
        return null;
    }
}

// 4. Get Schedule (Airing Today / Specified Day)
async function getScheduleJikan(day) {
    try {
        const res = await jikanClient.get(`https://api.jikan.moe/v4/schedules?filter=${day.toLowerCase()}`);
        const list = res.data?.data || [];
        return list.slice(0, 10).map(a => ({
            title: a.title_english || a.title,
            episodes: a.episodes || 'N/A',
            time: a.broadcast?.time || 'N/A'
        }));
    } catch (e) {
        console.error('Jikan Schedule Fetch Error:', e.response?.status || e.message);
        return null;
    }
}

// 5. Get Anime by Genre
async function getGenreJikan(genreName) {
    try {
        const genresRes = await jikanClient.get('https://api.jikan.moe/v4/genres/anime');
        const genres = genresRes.data?.data || [];
        const matchedGenre = genres.find(g => g.name.toLowerCase() === genreName.toLowerCase());

        if (!matchedGenre) return null;

        const res = await jikanClient.get(`https://api.jikan.moe/v4/anime?genres=${matchedGenre.mal_id}&limit=5`);
        return res.data?.data?.map(a => ({
            title: a.title_english || a.title,
            score: a.score || 'N/A',
            url: a.url
        })) || null;
    } catch (e) {
        console.error('Jikan Genre Fetch Error:', e.response?.status || e.message);
        return null;
    }
}

module.exports = {
    getAnimeJikan,
    getMangaJikan,
    getCharacterJikan,
    getScheduleJikan,
    getGenreJikan
};
