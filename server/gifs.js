const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authMiddleware } = require('./middleware');

router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q = 'funny', limit = 20 } = req.query;
    const response = await axios.get('https://tenor.googleapis.com/v2/search', {
      params: { q, key: process.env.TENOR_API_KEY, limit, media_filter: 'gif,tinygif', contentfilter: 'medium' }
    });
    const gifs = response.data.results.map(r => ({
      id: r.id, title: r.title,
      url: r.media_formats.gif?.url,
      preview: r.media_formats.tinygif?.url || r.media_formats.gif?.url,
    }));
    res.json(gifs);
  } catch (e) { res.status(500).json({ error: 'GIF search failed' }); }
});

router.get('/trending', authMiddleware, async (req, res) => {
  try {
    const response = await axios.get('https://tenor.googleapis.com/v2/featured', {
      params: { key: process.env.TENOR_API_KEY, limit: 20, media_filter: 'gif,tinygif', contentfilter: 'medium' }
    });
    const gifs = response.data.results.map(r => ({
      id: r.id, title: r.title,
      url: r.media_formats.gif?.url,
      preview: r.media_formats.tinygif?.url || r.media_formats.gif?.url,
    }));
    res.json(gifs);
  } catch (e) { res.status(500).json({ error: 'GIF fetch failed' }); }
});

module.exports = router;
