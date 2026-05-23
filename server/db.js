const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'chatroom',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
});

const db = {
  query: async (sql, params) => {
    const [rows] = await pool.query(sql, params);
    return rows;
  },
  queryOne: async (sql, params) => {
    const [rows] = await pool.query(sql, params);
    return rows[0] || null;
  }
};

module.exports = db;