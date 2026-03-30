CREATE DATABASE IF NOT EXISTS bedrock_network
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE bedrock_network;

CREATE TABLE IF NOT EXISTS servers (
  server_id VARCHAR(64) PRIMARY KEY,
  last_seen_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS player_sessions (
  player_id VARCHAR(64) PRIMARY KEY,
  server_id VARCHAR(64) NOT NULL,
  session_token CHAR(36) NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  connected_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_player_sessions_server
    FOREIGN KEY (server_id) REFERENCES servers(server_id)
      ON DELETE RESTRICT
      ON UPDATE CASCADE,
  INDEX idx_player_sessions_server (server_id),
  INDEX idx_player_sessions_lease (lease_expires_at)
);

CREATE TABLE IF NOT EXISTS player_profiles (
  player_id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(64) NOT NULL,
  profile_json JSON NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  last_server_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_player_profiles_server
    FOREIGN KEY (last_server_id) REFERENCES servers(server_id)
      ON DELETE SET NULL
      ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS player_inventories (
  player_id VARCHAR(64) PRIMARY KEY,
  inventory_json JSON NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  last_server_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_player_inventories_server
    FOREIGN KEY (last_server_id) REFERENCES servers(server_id)
      ON DELETE SET NULL
      ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS player_balances (
  player_id VARCHAR(64) PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0,
  revision INT NOT NULL DEFAULT 0,
  last_server_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_player_balances_server
    FOREIGN KEY (last_server_id) REFERENCES servers(server_id)
      ON DELETE SET NULL
      ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS economy_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  player_id VARCHAR(64) NOT NULL,
  counterparty_player_id VARCHAR(64) NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  server_id VARCHAR(64) NOT NULL,
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_economy_transactions_server
    FOREIGN KEY (server_id) REFERENCES servers(server_id)
      ON DELETE RESTRICT
      ON UPDATE CASCADE,
  INDEX idx_economy_transactions_player (player_id, created_at),
  INDEX idx_economy_transactions_counterparty (counterparty_player_id, created_at)
);

