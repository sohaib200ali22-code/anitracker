// Backup Fallback System using Kitsu API

// 1. Search Anime
async function getAnimeJikan(title) {
    try {
        const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
        if (!res.ok) return null;
        
        const data = await res.json();
        const anime = data?.data?.[0]?.attributes;
        if (!anime) return null;

        return {
            title: anime.canonicalTitle || anime.en || anime.en_jp,
            episodes: anime.episodeCount || 'N/A',
            status: anime.status ? anime.status.toUpperCase() : 'N/A',
            score: anime.averageRating ? `${(parseFloat(anime.averageRating) / 10).toFixed(1)} / 10` : 'N/A',
            image: anime.posterImage?.large || anime.posterImage?.original,
            url: `https://kitsu.io/anime/${data.data[0].id}`,
            synopsis: anime.synopsis ? anime.synopsis.slice(0, 300) + '...' : 'No description available.'
        };
    } catch (e) {
        console.error('Kitsu Anime Fetch Error:', e.message);
        return null;
    }
}

// 2. Search Manga
async function getMangaJikan(title) {
    try {
        const res = await fetch(`https://kitsu.io/api/edge/manga?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
        if (!res.ok) return null;
        
        const data = await res.json();
        const manga = data?.data?.[0]?.attributes;
        if (!manga) return null;

        return {
            title: manga.canonicalTitle || manga.en || manga.en_jp,
            chapters: manga.chapterCount || 'N/A',
            status: manga.status ? manga.status.toUpperCase() : 'N/A',
            score: manga.averageRating ? `${(parseFloat(manga.averageRating) / 10).toFixed(1)} / 10` : 'N/A',
            image: manga.posterImage?.large || manga.posterImage?.original,
            url: `https://kitsu.io/manga/${data.data[0].id}`,
            synopsis: manga.synopsis ? manga.synopsis.slice(0, 300) + '...' : 'No description available.'
        };
    } catch (e) {
        console.error('Kitsu Manga Fetch Error:', e.message);
        return null;
    }
}

// 3. Search Character
async function getCharacterJikan(name) {
    try {
        const res = await fetch(`https://kitsu.io/api/edge/characters?filter[name]=${encodeURIComponent(name)}&page[limit]=1`);
        if (!res.ok) return null;

        const data = await res.json();
        const char = data?.data?.[0]?.attributes;
        if (!char) return null;

        return {
            name: char.canonicalName || char.name,
            image: char.image?.original,
            about: char.description ? char.description.replace(/<[^>]*>?/gm, '').slice(0, 300) + '...' : 'No biography available.',
            url: `https://kitsu.io/characters/${data.data[0].id}`
        };
    } catch (e) {
        console.error('Kitsu Character Fetch Error:', e.message);
        return null;
    }
}

module.exports = {
    getAnimeJikan,
    getMangaJikan,
    getCharacterJikan
};
