// ==== MODULES, DB & APP SETUP ====
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bcrypt = require('bcryptjs');

const app = express();
const db = new sqlite3.Database('./gta_family.db');

// ==== AUTH MIDDLEWARE ====
// Kiểm tra đã đăng nhập
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// Kiểm tra role
function ensureRole(role) {
  return function(req, res, next) {
    if (req.isAuthenticated() && req.user.role === role) return next();
    res.status(403).send('Không đủ quyền!');
  };
}

// ==== MIDDLEWARE ====
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({
  secret: 'gta-secret',
  resave: false,
  saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

// ==== STATIC FILES ====
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// ==== PASSPORT CONFIGURATION ====

// Serialize/deserialize
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    done(err, user);
  });
});

// Discord OAuth config
passport.use(new DiscordStrategy({
  clientID: '1378421315400372417',
  clientSecret: 'zZG_Wq5zPSX8CBApyCYkuZIySl2P62zW',
  callbackURL: 'http://localhost:3000/auth/discord/callback',
  scope: ['identify', 'email']
}, function(accessToken, refreshToken, profile, done) {
  db.get('SELECT * FROM users WHERE discord_id = ?', [profile.id], (err, user) => {
    if (user) return done(null, user);
    db.run('INSERT INTO users (name, discord_id, role, status) VALUES (?, ?, ?, ?)', 
      [profile.username, profile.id, 'member', 'accepted'], function(err) {
        if (err) return done(err);
        db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (err, newUser) => done(err, newUser));
      });
  });
}));

// ==== VIEW RENDERING HELPER ====
function render(fileName) {
  return (req, res) => {
    fs.readFile(path.join(__dirname, 'views', fileName), 'utf-8', (err, data) => {
      if (err) return res.send('404 not found');
      res.send(data);
    });
  }
}

// ==== DATABASE INITIALIZATION ====
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    discord_id TEXT,
    age INTEGER,
    bio TEXT,
    reason TEXT,
    clan_id INTEGER,
    avatar TEXT,
    role TEXT DEFAULT 'member',
    password TEXT,
    status TEXT DEFAULT 'pending',
    score INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS clans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    banner TEXT,
    owner_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS join_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    clan_id INTEGER,
    status TEXT DEFAULT 'pending',
    message TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clan_id INTEGER,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ==== ROUTES ====

// ====== VIEWS ======
app.get('/', render('index.html'));
app.get('/login', render('login.html'));
app.get('/register', render('register.html'));
app.get('/clans', render('clan_list.html'));
app.get('/clan/:id', render('clan_detail.html'));

// Áp dụng middleware phân quyền vào các route quan trọng
app.get('/admin', ensureRole('admin'), render('admin.html'));
app.get('/clan-owner', ensureRole('clan_owner'), render('clan_owner.html'));

// ====== DISCORD AUTH ROUTES ======
// Bắt đầu đăng nhập với Discord
app.get('/auth/discord', passport.authenticate('discord'));

// Callback từ Discord về
app.get('/auth/discord/callback', passport.authenticate('discord', {
  failureRedirect: '/login'
}), (req, res) => {
  res.redirect('/'); // Đăng nhập thành công về trang chủ
});

// Đăng xuất
app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// ====== API ======

// Đăng ký tài khoản, nộp đơn vào clan
app.post('/api/register', (req, res) => {
  const { name, phone, discord_id, age, bio, reason, clan_id, avatar } = req.body;
  db.run(`INSERT INTO users (name, phone, discord_id, age, bio, reason, clan_id, avatar, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, phone, discord_id, age, bio, reason, clan_id, avatar, 'pending'], function(err) {
      if (err) return res.json({ success: false, error: err });
      res.json({ success: true, id: this.lastID });
    });
});

// Lấy danh sách clan
app.get('/api/clans', (req, res) => {
  db.all(`SELECT * FROM clans`, (err, rows) => {
    if (err) return res.json({ success: false, error: err });
    res.json({ success: true, clans: rows });
  });
});

// Lấy chi tiết clan
app.get('/api/clan/:id', (req, res) => {
  db.get(`SELECT * FROM clans WHERE id=?`, [req.params.id], (err, clan) => {
    if (err || !clan) return res.json({ success: false, error: 'Không tìm thấy' });
    db.all(`SELECT * FROM users WHERE clan_id=? AND status='accepted'`, [clan.id], (err, members) => {
      db.all(`SELECT * FROM announcements WHERE clan_id=?`, [clan.id], (err, announcements) => {
        res.json({ success: true, clan, members, announcements });
      });
    });
  });
});

// Route kiểm tra xem user đã đăng nhập chưa và trả về thông tin user
app.get('/api/me', (req, res) => {
  if (req.user) res.json({loggedIn:true, name: req.user.name, role: req.user.role});
  else res.json({loggedIn:false});
});

// ==== API CLAN REQUESTS ====
// Lấy danh sách đơn xin vào clan (chỉ clan_owner xem được đơn của clan mình)
app.get('/api/requests', ensureRole('clan_owner'), (req, res) => {
  db.all(`SELECT join_requests.id, users.name, users.discord_id, join_requests.status
    FROM join_requests JOIN users ON join_requests.user_id=users.id
    WHERE join_requests.clan_id = (SELECT id FROM clans WHERE owner_id=?)`, [req.user.id], (err, rows) => {
      if (err) return res.json({success:false, error:err});
      res.json({success:true, requests:rows});
    });
});

// Duyệt hoặc từ chối đơn
app.post('/api/requests/:id/approve', ensureRole('clan_owner'), (req, res) => {
  db.run(`UPDATE join_requests SET status='accepted' WHERE id=?`, [req.params.id], function(err){
    if (err) return res.json({success:false, error:err});
    res.json({success:true});
  });
});
app.post('/api/requests/:id/reject', ensureRole('clan_owner'), (req, res) => {
  db.run(`UPDATE join_requests SET status='rejected', message=? WHERE id=?`, [req.body.message, req.params.id], function(err){
    if (err) return res.json({success:false, error:err});
    res.json({success:true});
  });
});

// ==== API ADMIN ====
// Lấy danh sách user + clan cho admin
app.get('/api/admin/data', ensureRole('admin'), (req, res)=>{
  db.all('SELECT * FROM users', (e,users)=>{
    db.all('SELECT * FROM clans', (e2,clans)=>{
      res.json({success:true,users,clans});
    });
  });
});
// Đổi role user
app.post('/api/admin/setrole/:id', ensureRole('admin'), (req,res)=>{
  db.run('UPDATE users SET role=? WHERE id=?', [req.body.role, req.params.id], (e)=>{
    res.json({success:!e});
  });
});
// Xóa clan
app.post('/api/admin/deleteclan/:id', ensureRole('admin'), (req,res)=>{
  db.run('DELETE FROM clans WHERE id=?', [req.params.id], (e)=>{
    res.json({success:!e});
  });
});

// ==== API RANKING ====
// Bảng xếp hạng clan và thành viên
app.get('/api/ranking', (req,res)=>{
  db.all(`SELECT clans.name, COUNT(users.id) as total 
    FROM clans LEFT JOIN users ON clans.id=users.clan_id AND users.status='accepted'
    GROUP BY clans.id ORDER BY total DESC`, (e,clanRanking)=>{
    db.all(`SELECT name, IFNULL(score,0) as score FROM users ORDER BY score DESC LIMIT 10`, (e2,memberRanking)=>{
      res.json({clanRanking, memberRanking});
    });
  });
});

// ==== API ANNOUNCEMENTS ====
// Lấy danh sách thông báo (tất cả clan)
app.get('/api/announcement', ensureAuthenticated, (req, res) => {
  db.all('SELECT * FROM announcements ORDER BY created_at DESC', (e, list) => {
    res.json({ list });
  });
});
// Gửi thông báo mới cho clan (người đã đăng nhập)
app.post('/api/announcement', ensureAuthenticated, (req, res) => {
  db.run('INSERT INTO announcements (clan_id, content) VALUES (?,?)', [req.user.clan_id, req.body.content], (e) => {
    res.json({ success: !e });
  });
});

// (Bạn có thể thêm các API khác như duyệt đơn, đăng nhập, thông báo, phân quyền...)

// ====== SERVER START ======
app.listen(3000, () => console.log('Server running at http://localhost:3000'));