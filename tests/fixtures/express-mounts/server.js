import express from 'express';
import rateLimit from 'express-rate-limit';
import itemRoutes from './routes/items.js';
import adminRoutes from './routes/admin/index.js';

const app = express();
const authLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// rate limiters on a path are middleware, not routers: they must not prefix every route
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.use('/api/items', itemRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/ping', (req, res) => res.json({ ok: true }));

export default app;
