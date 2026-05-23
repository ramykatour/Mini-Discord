require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const passport = require('./passport');
const authRoutes = require('./auth');
const roomRoutes = require('./rooms');
const adminRoutes = require('./admin');
const dmRoutes = require('./dms');
const gifRoutes = require('./gifs');
const setupSocket = require('./socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({ secret: process.env.SESSION_SECRET || 'secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

app.use('/auth',        authRoutes);
app.use('/api/rooms',   roomRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/dm',      dmRoutes);
app.use('/api/gifs',    gifRoutes);

app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, '../public/pages/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/register.html')));
app.get('*',         (req, res) => res.sendFile(path.join(__dirname, '../public/pages/app.html')));

setupSocket(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ChatRoom running at http://localhost:${PORT}`));
