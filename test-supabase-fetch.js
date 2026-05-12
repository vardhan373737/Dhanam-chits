require('dotenv').config();
(async () => {
  try {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error('SUPABASE_URL not set');
    console.log('Testing fetch to', url);
    const res = await fetch(url, { method: 'HEAD' });
    console.log('Status:', res.status);
  } catch (err) {
    console.error('Fetch error:', err);
    if (err.cause) console.error('Cause:', err.cause);
  }
})();
