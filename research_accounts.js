const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres.nonncixsdfejjfutzutb:0v17DRX2FEcmQ80N@aws-1-us-east-2.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query("SELECT id, gamertag, xuid FROM players WHERE gamertag ILIKE '%Serafim%'");
    console.log('--- RELATÓRIO DE CONTAS ENCONTRADAS ---');
    res.rows.forEach(r => {
      console.log(`Nome: ${r.gamertag} | XUID: ${r.xuid} | ID: ${r.id}`);
    });
    console.log('---------------------------------------');
  } catch (err) {
    console.error('Erro na pesquisa:', err);
  } finally {
    await pool.end();
  }
}
run();
