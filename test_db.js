const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres.nonncixsdfejjfutzutb:0v17DRX2FEcmQ80N@aws-1-us-east-2.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const client = await pool.connect();
  try {
    const players = await client.query('SELECT count(*) FROM players');
    const balances = await client.query('SELECT p.gamertag, a.balance FROM accounts a JOIN players p ON a.player_id = p.id WHERE a.currency_code = \'DRACO\' ORDER BY a.balance DESC');
    
    console.log('--- RELATÓRIO DO BANCO ---');
    console.log(`Total de Jogadores: ${players.rows[0].count}`);
    console.log('Saldos (TOP):');
    balances.rows.forEach(r => console.log(`- ${r.gamertag}: ${r.balance}`));
  } finally {
    client.release();
    pool.end();
  }
}

check().catch(console.error);
