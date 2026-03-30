import express from 'express';
import { PORT } from './config.js';
import { pingDatabase } from './db.js';
import { healthRouter } from './routes/health.js';
import { networkRouter } from './routes/network.js';
import { formatError, getErrorStatus } from './services/networkService.js';

const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Bedrock Network backend is running.'
  });
});

app.use('/health', healthRouter);
app.use('/api', networkRouter);

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  res.status(getErrorStatus(error)).json(formatError(error));
});

async function start() {
  await pingDatabase();

  app.listen(PORT, () => {
    console.log(`[bedrock-network-backend] listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error('[bedrock-network-backend] failed to start:', error);
  process.exit(1);
});
