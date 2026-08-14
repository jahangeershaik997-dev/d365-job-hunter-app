const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const schedule = require('node-schedule');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

// Passport Google Strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL
}, (accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Routes
app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

app.get('/register', (req, res) => {
  res.render('register', { user: req.user });
});

app.get('/dashboard', (req, res) => {
  if (!req.user) return res.redirect('/');
  res.render('dashboard', { user: req.user });
});

app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send']
}));

app.get('/auth/callback', passport.authenticate('google', {
  failureRedirect: '/'
}), (req, res) => {
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// Start server
app.listen(PORT, () => {
  console.log(\🚀 Server running on port \\);
});
