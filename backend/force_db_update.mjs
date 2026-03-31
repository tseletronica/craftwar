import { pool } from './src/lib/db.js';

async function fix() {
  const client = await pool.connect();
  try {
    const players = await client.query("SELECT id, gamertag, xuid FROM players");
    console.log("[SCAN] Total de jogadores no banco:", players.rows.length);
    
    // Procura por Serafim independente de maiúsculas/minúsculas
    const serafims = players.rows.filter(p => String(p.gamertag).toLowerCase().includes('serafim'));
    
    if (serafims.length === 0) {
      console.log("[ERRO_CRITICO] O jogador SerafimM2025 (ou similar) NÃO ESTÁ CADASTRADO validamente no banco de dados.");
      return;
    }

    for (const p of serafims) {
      console.log(`[ATUALIZANDO] Jogador Detectado: ${p.gamertag} (XUID: ${p.xuid}) (PID: ${p.id})`);
      
      // Insere ou atualiza o saldo da conta DRACO
      const res = await client.query(`
        INSERT INTO accounts (player_id, currency_code, balance)
        VALUES ($1, 'DRACO', 1000000000)
        ON CONFLICT (player_id, currency_code) 
        DO UPDATE SET balance = 1000000000
        RETURNING balance;
      `, [p.id]);
      
      console.log(`[SQL_SUCCESS] Novo saldo de DRACO gravado no Supabase para ${p.gamertag}: ${res.rows[0].balance}`);
    }
  } catch (err) {
    console.error("[ERRO_FATAL_NO_SQL]", err);
  } finally {
    client.release();
    pool.end();
  }
}

fix();
