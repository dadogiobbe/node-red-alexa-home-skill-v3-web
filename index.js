var url = require('url');
var http = require('http');
var https = require('https');
var favicon = require('serve-favicon')
var flash = require('connect-flash');
var morgan = require('morgan');
var express = require('express');
const session = require('express-session');
const mongoStore = require('connect-mongo')(session);
var passport = require('passport');
// MongoDB =======================
var db = require('./config/db');
var Account = db.Account;
var oauthModels = db.oauthModels;
var Devices = db.Devices;
var Topics = db.Topics;
var LostPassword = db.LostPassword;
// ===============================
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
const request = require('request');
var PassportOAuthBearer = require('passport-http-bearer');
var oauthServer = require('./oauth');
var countries = require('countries-api');
var ua = require('universal-analytics');
// Winston Logger ==========================
var logger = require('./config/logger');
// =========================================
var enableAnalytics = true;
var consoleLoglevel = "info"; // default console log level
var enableGoogleHomeSync = true;

// Configure Logging, with Exception Handler
var debug = (process.env.ALEXA_DEBUG || false);
if (debug == "true") {consoleLoglevel = "debug"};
logger.log('info', "[Core] Log Level set to: " + consoleLoglevel);

// Use GA account ID specified in container definition
if (!(process.env.GOOGLE_ANALYTICS_TID)) {
	logger.log('warn',"[Core] UID for Google Analytics not supplied via environment variable GOOGLE_ANALYTICS_TID");
	enableAnalytics = false;
}
else {
	var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}
// Validate CRITICAL environment variables passed to container
if (!(process.env.MONGO_USER && process.env.MONGO_PASSWORD && process.env.MQTT_USER && process.env.MQTT_PASSWORD && process.env.MQTT_PORT)) {
	logger.log('error',"[Core] You MUST supply MONGO_USER, MONGO_PASSWORD, MQTT_USER, MQTT_PASSWORD and MQTT_PORT environment variables");
	process.exit()
}
// Warn on not supply of MONGO/ MQTT host names
if (!(process.env.MONGO_HOST && process.env.MQTT_URL)) {
	logger.log('warn',"[Core] Using 'mongodb' for Mongodb and 'mosquitto' for MQTT service endpoints, no MONGO_HOST/ MQTT_URL environment variable supplied");
}
// Warn on not supply of MAIL username/ password/ server
if (!(process.env.MAIL_SERVER && process.env.MAIL_USER && process.env.MAIL_PASSWORD)) {
	logger.log('warn',"[Core] No MAIL_SERVER/ MAIL_USER/ MAIL_PASSWORD environment variable supplied. System generated emails will generate errors");
}
// Warn on SYNC_API not being specified/ request SYNC will be disabled
if (!(process.env.HOMEGRAPH_APIKEY)){
	logger.log('warn',"[Core] No HOMEGRAPH_APIKEY environment variable supplied. New devices, removal or device changes will not show in users Google Home App without this");
	enableGoogleHomeSync = false;
}
else {
	var SYNC_API = "https://homegraph.googleapis.com/v1/devices:requestSync?key=" + process.env.HOMEGRAPH_APIKEY;
}

// NodeJS App Settings
var port = (process.env.VCAP_APP_PORT || 3000);
var host = (process.env.VCAP_APP_HOST || '0.0.0.0');
// MongoDB Settings, used for expression session handler DB connection
var mongo_user = (process.env.MONGO_USER);
var mongo_password = (process.env.MONGO_PASSWORD);
var mongo_host = (process.env.MONGO_HOST || "mongodb");
var mongo_port = (process.env.MONGO_PORT || "27017");
// MQTT Settings
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
// Express Settings
if (process.env.VCAP_APPLICATION) {
	var application = JSON.parse(process.env.VCAP_APPLICATION);
	var app_uri = application['application_uris'][0];
	app_id = 'https://' + app_uri;
}
else {
	var app_id = 'http://localhost:' + port;
}

var cookieSecret = (process.env.COOKIE_SECRET || 'ihytsrf334');
if (cookieSecret == 'ihytsrf334') {logger.log("warn", "[Security] Using default Cookie Secret, please supply new secret using COOKIE_SECRET environment variable")}
else {logger.log("info", "[Security] Using user-defined cookie secret")}

// MQTT Client ==========================
var mqttClient = require('./config/mqtt');
// ======================================

// Check admin account exists, if not create it using same credentials as MQTT user/password supplied
Account.findOne({username: mqtt_user}, function(error, account){
	if (!error && !account) {
		Account.register(new Account({username: mqtt_user, email: '', mqttPass: '', superuser: 1}),
			mqtt_password, function(err, account){
			var topics = new Topics({topics: [
					'command/' +account.username+'/#', 
					'state/' + account.username + '/#',
					'response/' + account.username + '/#'
				]});
			topics.save(function(err){
				if (!err){
					var s = Buffer.from(account.salt, 'hex').toString('base64');
					var h = Buffer.from(account.hash, 'hex').toString(('base64'));
					var mqttPass = "PBKDF2$sha256$901$" + account.salt + "$" + account.hash;
					Account.updateOne(
						{username: account.username}, 
						{$set: {mqttPass: mqttPass, topics: topics._id}}, 
						function(err, count){
							if (err) {
								logger.log('error', err);
							}
						}
					);
				}
			});
		});
	} else {
		logger.log('info', "[Core] Superuser MQTT account, " + mqtt_user + " already exists");
	}
});

var app = express();

// Redis Client ==========================
var client = require('./config/redis')
// =======================================

// Rate-limiter 
const limiter = require('express-limiter')(app, client)

// GetState Limiter, uses specific param, 100 reqs/ hr
const getStateLimiter = limiter({
	lookup: function(req, res, opts, next) {
		  opts.lookup = ['params.dev_id']
		  opts.total = 100
		  opts.expire = 1000 * 60 * 60
		  return next()
	},
	onRateLimited: function (req, res, next) {
		if (req.hasOwnProperty('user')) {
			logger.log('warn', "Rate limit exceeded for user:" + req.user.username)
			var params = {
				ec: "Express-limiter",
				ea: "Rate limited: " + req.user.username,
				uid: req.user.username,
				uip: req.ip
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
		else {
			logger.log('warn', "[Rate Limiter] GetState rate-limit exceeded for IP address:" + req.ip)
			var params = {
				ec: "Express-limiter",
				ea: "GetState: rate-limited path: " + req.path + ", IP address:" + req.ip,
				uip: req.ip
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
		res.status(429).json('Rate limit exceeded for GetState API');
	  }
  });

// Restrictive Limiter, used to prevenmt abuse on NewUser, Login, 10 reqs/ hr
const restrictiveLimiter = limiter({
	lookup: function(req, res, opts, next) {
		opts.lookup = 'connection.remoteAddress'
		opts.total = 10
		opts.expire = 1000 * 60 * 60
		return next()
  },
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] Restrictive rate-limit exceeded for path: " + req.path + ",  IP address:" + req.ip)
		var params = {
			ec: "Express-limiter",
			ea: "Restrictive: rate-limited path: " + req.path + ", IP address:" + req.ip,
			uip: req.ip
		  }
		if (enableAnalytics) {visitor.event(params).send()};
		res.status(429).json('Rate limit exceeded');
	}
});

// Default Limiter, used on majority of routers ex. OAuth2-related and Command API
const defaultLimiter = limiter({
	lookup: function(req, res, opts, next) {
		opts.lookup = 'connection.remoteAddress'
		opts.total = 100
		opts.expire = 1000 * 60 * 60
		return next()
  },
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] Default rate-limit exceeded for path: " + req.path + ", IP address:" + req.ip)
		var params = {
			ec: "Express-limiter",
			ea: "Default: rate-limited path: " + req.path + ", IP address:" + req.ip,
			uip: req.ip
		  }
		if (enableAnalytics) {visitor.event(params).send()};
		res.status(429).json('Rate limit exceeded');
	  }
});

app.set('view engine', 'ejs');
app.enable('trust proxy');
app.use(favicon('static/favicon.ico'));
app.use(morgan("combined", {stream: logger.stream})); // change to use Winston
app.use(cookieParser(cookieSecret));
app.use(flash());

// Session handler
app.use(session({
	store: new mongoStore({
		url: "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/sessions"
	}),
	resave: true,
	saveUninitialized: true,
	secret: 'ihytsrf334'
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(passport.initialize());
app.use(passport.session());

function requireHTTPS(req, res, next) {
	if (req.get('X-Forwarded-Proto') === 'http') {
        var url = 'https://' + req.get('host');
        if (req.get('host') === 'localhost') {
        	url += ':' + port;
        }
        url  += req.url;
        return res.redirect(url); 
    }
    next();
}

app.use(requireHTTPS);

app.use('/',express.static('static')); // Static content router
app.use('/octicons', express.static('node_modules/octicons/build'), express.static('node_modules/octicons/build/svg')); // Octicons router

passport.use(new LocalStrategy(Account.authenticate()));

passport.use(new BasicStrategy(Account.authenticate()));

passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());

var accessTokenStrategy = new PassportOAuthBearer(function(token, done) {
	oauthModels.AccessToken.findOne({ token: token }).populate('user').populate('grant').exec(function(error, token) {
		if (!error && token && !token.grant) {
			logger.log('error', "[Core] Missing grant token:" + token);
		}
		if (!error && token && token.active && token.grant && token.grant.active && token.user) {
			logger.log('debug', "[Core] OAuth Token good, token:" + token);
			done(null, token.user, { scope: token.scope });
		} else if (!error) {
			logger.log('error', "[Core] OAuth Token error, token:" + token);
			done(null, false);
		} else {
			logger.log('error', "[Core] OAuth Token error:" + error);
			done(error);
		}
	});
});

passport.use(accessTokenStrategy);

app.get('/', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Home',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/index', {user: req.user, home: true});
});

app.get('/docs', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Docs',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/docs', {user: req.user, docs: true});
});

app.get('/about', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'About',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/about', {user: req.user, about: true});
});

app.get('/privacy', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Privacy',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/privacy', {user: req.user, privacy: true});
});

app.get('/tos', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Terms of Service',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/tos', {user: req.user, tos: true});
});

app.get('/login', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Login',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/login',{user: req.user, login: true, message: req.flash('error')});
});

app.get('/logout', defaultLimiter, function(req,res){
	req.logout();
	if (req.query.next) {
		//console.log(req.query.next);
		res.redirect(req.query.next);
	} else {
		res.redirect('/');
	}
	
});

//app.post('/login',passport.authenticate('local', { failureRedirect: '/login', successRedirect: '/2faCheck', failureFlash: true }));
app.post('/login', restrictiveLimiter,
	passport.authenticate('local',{ failureRedirect: '/login', failureFlash: true, session: true }),
	function(req,res){
		var params = {
			ec: "Security", // class
			ea: "Login", //action
			uid: req.user,
			uip: req.ip,
			dp: "/login"
		  }
		if (enableAnalytics) {visitor.pageview(params).send()};

		if (req.query.next) {
			res.reconnect(req.query.next);
		} else {
			if (req.user.username != mqtt_user) {
				res.redirect('/devices');
			}
			else {
				res.redirect('/admin/users');
			}
		}
	});

function ensureAuthenticated(req,res,next) {
	//console.log("ensureAuthenticated - %j", req.isAuthenticated());
	//console.log("ensureAuthenticated - %j", req.user);
	//console.log("ensureAuthenticated - %j", req.session);
	if (req.isAuthenticated()) {
    	return next();
	} else {
		//console.log("failed auth?");
		res.redirect('/login');
	}
}

app.get('/newuser', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'New User',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/register',{user: req.user, newuser: true});
});

app.post('/newuser', restrictiveLimiter, function(req,res){
	var body = JSON.parse(JSON.stringify(req.body));
	if (body.hasOwnProperty('username') && body.hasOwnProperty('email') && body.hasOwnProperty('country') && body.hasOwnProperty('password')) {
		const country = countries.findByCountryCode(req.body.country.toUpperCase());
		Promise.all([country]).then(([userCountry]) => {
			if (country.statusCode == 200) {
				var region = userCountry.data[0].region;
				Account.register(new Account({ username : req.body.username, email: req.body.email, country: req.body.country.toUpperCase(), region: region,  mqttPass: "foo" }), req.body.password, function(err, account) {
					if (err) {
						logger.log('error', "[New User] New user creation error: " + err);
						return res.status(400).send(err.message);
					}
					var topics = new Topics({topics: [
							'command/' + account.username +'/#', 
							'state/'+ account.username + '/#',
							'response/' + account.username + '/#'
						]});
					topics.save(function(err){
						if (!err){
							var s = Buffer.from(account.salt, 'hex').toString('base64');
							var h = Buffer.from(account.hash, 'hex').toString(('base64'));
							var mqttPass = "PBKDF2$sha256$901$" + account.salt + "$" + account.hash;
							Account.updateOne(
								{username: account.username}, 
								{$set: {mqttPass: mqttPass, topics: topics._id}}, 
								function(err, count){
									if (err) {
										logger.log('error' , "[New User] New user creation error updating MQTT info: " + err);
									}
								}
							);
						}
					});
					passport.authenticate('local')(req, res, function () {
						logger.log('info', "[New User] Created new user, username: " + req.body.username + " email:"  + req.body.email + " country:" +  req.body.country + " region:" + region );
						var params = {
							ec: "Security",
							ea: "Create user, username:" + req.body.username + " email:"  + req.body.email + " country:" +  req.body.country + " region:" + region,
							uid: req.user,
							dp: "/newuser"
						}
						if (enableAnalytics) {visitor.event(params).send()};
						res.status(201).send();
					});
				});
			}
		}).catch(err => {
			logger.log('warn', "[New User] User region lookup failed.");
			res.status(500).send("Account creation failed, please check country is correctly specified!");
		});
	}
	else {
		logger.log('warn', "[New User] Missing/ incorrect elements supplied for user account creation");
		res.status(500).send("Missing required attributes, please check registration form!");
	}
});


app.get('/changePassword/:key', defaultLimiter, function(req, res, next){
	var uuid = req.params.key;
	LostPassword.findOne({uuid: uuid}).populate('user').exec(function(error, lostPassword){
		if (!error && lostPassword) {
			req.login(lostPassword.user, function(err){
				if (!err){
					lostPassword.remove();
					res.redirect('/changePassword');
				} else {
					logger.log('warn', "[Change Password] Unable to find correlating password reset key for user: " + lostPassword.user);
					//logger.log('debug', "[Change Password] " + err);
					res.redirect('/');
				}
			})
		} else {
			res.redirect('/');
		}
	});
});

app.get('/changePassword', defaultLimiter, ensureAuthenticated, function(req, res, next){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Change Password',
		uid: req.user.username,
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};
	
	res.render('pages/changePassword', {user: req.user});
});

app.post('/changePassword', restrictiveLimiter, ensureAuthenticated, function(req, res, next){
	Account.findOne({username: req.user.username}, function (err, user){
		if (!err && user) {
			user.setPassword(req.body.password, function(e,u){
				// var s = Buffer.from(account.salt, 'hex').toString('base64');
				// var h = Buffer.from(account.hash, 'hex').toString(('base64'));
				var mqttPass = "PBKDF2$sha256$901$" + user.salt + "$" + user.hash;
				u.mqttPass = mqttPass;
				u.save(function(error){
					if (!error) {
						//console.log("Chagned %s's password", u.username);
						var params = {
							ec: "Security",
							ea: "Changed password for username:" + u.username,
							uid: req.user,
							dp: "/changePassword"
						  }
						if (enableAnalytics) {visitor.event(params).send()};
						res.status(200).send();
					} else {
						logger.log('warn', "[Change Password] Unable to change password for: " + u.username);
						logger.log('debug', "[Change Password] " + error);
						res.status(400).send("Problem setting new password");
					}
				});
			});
		} else {
			logger.log('warn', "[Change Password] Unable to change password for user, user not found: " + req.user.username);
			logger.log('debug', "[Change Password] " + err);
			res.status(400).send("Problem setting new password");
		}
	});
});

app.get('/lostPassword', defaultLimiter, function(req, res, next){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Lost Password',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/lostPassword', { user: req.user});
});

var sendemail = require('./sendemail');
var mailer = new sendemail();

app.post('/lostPassword', restrictiveLimiter, function(req, res, next){
	var email = req.body.email;
	Account.findOne({email: email}, function(error, user){
		if (!error){
			if (user){
				var lostPassword = new LostPassword({user: user});
				//console.log(lostPassword);
				lostPassword.save(function(err){
					if (!err) {
						res.status(200).send();
					}
					//console.log(lostPassword.uuid);
					//console.log(lostPassword.user.username);
					var body = mailer.buildLostPasswordBody(lostPassword.uuid, lostPassword.user.username);
					mailer.send(email, 'nr-alexav3@cb-net.co.uk', 'Password Reset for Node-Red-Alexa-Smart-Home-v3', body.text, body.html);
				});
			} else {
				res.status(404).send("No user found with that email address");
			}
		}
	});
});

// Oauth related code, some help here in getting this working: https://github.com/hardillb/alexa-oauth-test
// See README.md for Alexa Skill Authentication settings.

// Authorization URI
app.get('/auth/start',oauthServer.authorize(function(applicationID, redirectURI, done) {
	if (typeof applicationID == "string") {applicationID = parseInt(applicationID)};
	oauthModels.Application.findOne({ oauth_id: applicationID }, function(error, application) {
		if (application) {
			logger.log("debug", "[Oauth2] Starting Auth for application:" + application.title);
			var match = false, uri = url.parse(redirectURI || '');
			for (var i = 0; i < application.domains.length; i++) {
				logger.log('info', "[Oauth2] Checking OAuth redirectURI against defined service domain: " + application.domains[i]);
				if (uri.host == application.domains[i] || (uri.protocol == application.domains[i] && uri.protocol != 'http' && uri.protocol != 'https')) {
					match = true;
					logger.log('info', "[Oauth2] Found Service definition associated with redirectURI: " + redirectURI);
					break;
				}
			}
			if (match && redirectURI && redirectURI.length > 0) {
				done(null, application, redirectURI);
			} else {
				done(new Error("ERROR: Could not find service definition associated with redirectURI: ", redirectURI), false);
			}
		} else if (!error) {
			done(new Error("ERROR: No serevice definition associated with oauth client_id: ", applicationID), false);
		} else {
			done(error);
		}
	});
	
// Oauth Scopes
}),function(req,res){
	var scopeMap = {
		// ... display strings for all scope variables ...
		access_devices: 'access your devices',
		create_devices: 'create new devices'
	};

	res.render('pages/oauth', {
		transaction_id: req.oauth2.transactionID,
		currentURL: encodeURIComponent(req.originalUrl),
		response_type: req.query.response_type,
		errors: req.flash('error'),
		scope: req.oauth2.req.scope,
		application: req.oauth2.client,
		user: req.user,
		map: scopeMap
	});
});

app.post('/auth/finish',function(req,res,next) {
	//console.log("/auth/finish user: ", req.user);
	//console.log(req.body);
	//console.log(req.params);
	if (req.user) {
		logger.log("debug", "[OAuth2] User already logged in:" + req.user.username);
		next();
	} else {
		passport.authenticate('local', {
			session: false
		}, function(error,user,info){
			//console.log("/auth/finish authenticating");
			if (user) {
				logger.log('info', "[Oauth2] Authenticated: " + user.username);
				req.user = user;
				next();
			} else if (!error){
				logger.log('warn', "[Oauth2] User not authenticated");
				req.flash('error', 'Your email or password was incorrect. Please try again.');
				res.redirect(req.body['auth_url'])
			}
			else {
				logger.log('error', "[Oauth2] Auth error: " + error);
			}
 		})(req,res,next);
	}
}, oauthServer.decision(function(req,done){
	//console.log("decision user: ", req);
	done(null, { scope: req.oauth2.req.scope });
}));

// Access Token URI
app.post('/auth/exchange',function(req,res,next){
	var appID = req.body['client_id'];
	var appSecret = req.body['client_secret'];

	oauthModels.Application.findOne({ oauth_id: appID, oauth_secret: appSecret }, function(error, application) {
		if (application) {
			req.appl = application;
			logger.log("debug", "[Oauth2] Exchange application:" + application);
			next();
		} else if (!error) {
			error = new Error("ERROR: Could not find service definition associated with applicationID: " + appID + " or secret: " + appSecret);
			logger.log("debug", "[Oauth2] Could not find service definition associated with applicationID: " + appID + " or secret: " + appSecret);
			next(error);
		} else {
			logger.log("debug", "[Oauth2] Error:" + error);
			next(error);
		}
	});
}, oauthServer.token(), oauthServer.errorHandler());

/////////////////////// Start GHome
app.post('/api/v1/action', defaultLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
	logger.log('verbose', "[GHome API] Request:" + JSON.stringify(req.body));
	var intent = req.body.inputs[0].intent;
	var requestId = req.body.requestId;

	switch (intent) {
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.SYNC' :
			logger.log('verbose', "[GHome Sync API] Running device discovery for user:" + req.user.username);
			var params = {
				ec: "SYNC",
				ea: "GHome SYNC event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			if (debug == "true") {console.time('ghome-sync')};
			var findUser = Account.find({username: req.user.username});
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (user && devices) {
					logger.log('debug', "[GHome Sync API] User: " + JSON.stringify(user[0]));
					logger.log('debug', "[GHome Sync API] Devices: " + JSON.stringify(devices));
					// Build Device Array
					var devs = [];
					for (var i=0; i< devices.length; i++) {
						var deviceJSON = JSON.parse(JSON.stringify(devices[i])); 
						var dev = {}
						dev.id = "" + devices[i].endpointId;
						dev.type = gHomeReplaceType(devices[i].displayCategories);
						dev.traits = [];
						// Check supported device type
						if (dev.type != "NA") {
							// Check supported capability/ trait
							devices[i].capabilities.forEach(function(capability){
								var trait = gHomeReplaceCapability(capability);
								// Add supported traits, don't add duplicates
								if (trait != "Not Supported" && dev.traits.indexOf(trait) == -1){
									dev.traits.push(trait);
								}
							});
						}
						dev.name = {
							name : devices[i].friendlyName
							}
						dev.willReportState = devices[i].reportState;
						dev.attributes = devices[i].attributes;
						// Populate attributes, remap roomHint to device root
						if (deviceJSON.hasOwnProperty('attributes')) {
							if (deviceJSON.attributes.hasOwnProperty('roomHint')){
								delete dev.attributes.roomHint;
								if (deviceJSON.attributes.roomHint != ""){dev.roomHint = deviceJSON.attributes.roomHint};
							}
						}
						// Add colorModel attribute if color is supported interface/ trait
						if (devices[i].capabilities.indexOf("ColorController") > -1 ){
							dev.attributes.colorModel = "hsv";
							delete dev.attributes.commandOnlyColorSetting; // defaults to false anyway
						}
						// Pass min/ max values as float
						if (devices[i].capabilities.indexOf("ColorTemperatureController") > -1 ){
							dev.attributes.colorTemperatureRange.temperatureMinK = parseInt(dev.attributes.colorTemperatureRange.temperatureMinK);
							dev.attributes.colorTemperatureRange.temperatureMaxK = parseInt(dev.attributes.colorTemperatureRange.temperatureMaxK);
						}

						// action.devices.traits.TemperatureSetting, adjust dev.attributes to suit Google Home
						if (dev.traits.indexOf("action.devices.traits.TemperatureSetting") > -1 ){
							//dev.attributes.availableThermostatModes = dev.attributes.thermostatModes.map(function(x){return x.toLowerCase()});
							dev.attributes.availableThermostatModes = dev.attributes.thermostatModes.join().toLowerCase(); // Make string, not array
							dev.attributes.thermostatTemperatureUnit = dev.attributes.temperatureScale.substring(0, 1); // >> Need to make this upper F or C, so trim
							delete dev.attributes.temperatureRange;
							delete dev.attributes.temperatureScale;
							delete dev.attributes.thermostatModes;
						}
						dev.deviceInfo = {
							manufacturer : "Node-RED",
							model : "Node-RED",
							hwVersion : "0.1",
							swVersion : "0.1"
						}
						// Limit supported traits, don't add other device types
						if (dev.traits.length > 0 && dev.type != "NA") {
							devs.push(dev);
						}
					}

					// Build Response
					var response = {
						"requestId": requestId,
						"payload": {
							"agentUserId": user[0]._id,
							"devices" : devs
						}
					}
					logger.log('verbose', "[GHome Sync API] Discovery Response: " + JSON.stringify(response));
					// Send Response
					res.status(200).json(response);
					if (debug == "true") {console.timeEnd('ghome-sync')};
				}
				else if (!user){
					logger.log('warn', "[GHome Sync API] User not found");
					res.status(500).json({message: "User not found"});
					if (debug == "true") {console.timeEnd('ghome-sync')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Sync API] Device not found");
					res.status(500).json({message: "Device not found"});
					if (debug == "true") {console.timeEnd('ghome-sync')};
				}
			}).catch(err => {
				logger.log('error', "[GHome Sync API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				if (debug == "true") {console.timeEnd('ghome-sync')};
			});
			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.EXECUTE' : 
			logger.log('verbose', "[GHome Exec API] Execute command for user:" + req.user.username);
			var params = {
				ec: "EXECUTE",
				ea: "GHome EXECUTE event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			if (debug == "true") {console.time('ghome-exec')};
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (devices) {
					var arrCommands = req.body.inputs[0].payload.commands; // Array of commands, assume match with device array at same index?!
					logger.log('debug', "[GHome Exec API] Returned mongodb devices typeof:" + typeof devices);
					//var devicesJSON = JSON.parse(JSON.stringify(devices));
					//logger.log('debug', "[GHome Exec API] User devices:" + JSON.stringify(devicesJSON));
					for (var i=0; i< arrCommands.length; i++) { // Iterate through commands in payload, against each listed 
						var arrCommandsDevices =  req.body.inputs[0].payload.commands[i].devices; // Array of devices to execute commands against
						var params = arrCommands[i].execution[0].params; // Google Home Parameters
						var validationStatus = true;
						// Match device to returned array in case of any required property/ validation
						arrCommandsDevices.forEach(function(element) {
							//logger.log('debug', "[GHome Exec API] Attempting to matching command device: " + element.id + ", against devicesJSON");
							var data = devices.find(obj => obj.endpointId == element.id);
							if (data == undefined) {logger.log('debug', "[GHome Exec API] Failed to match device against devicesJSON")}
							else {logger.log('debug', "[GHome Exec API] Executing command against device:" + JSON.stringify(data))}
							// Handle Thermostat valueOutOfRange
							if (arrCommands[i].execution[0].command == "action.devices.commands.ThermostatTemperatureSetpoint") {
								var hastemperatureMax = getSafe(() => data.attributes.temperatureRange.temperatureMax);
								var hastemperatureMin = getSafe(() => data.attributes.temperatureRange.temperatureMin);
								if (hastemperatureMin != undefined && hastemperatureMax != undefined) {
									var temperatureMin = data.attributes.temperatureRange.temperatureMin;
									var temperatureMax = data.attributes.temperatureRange.temperatureMax;
									logger.log('debug', "[GHome Exec API] Checking requested setpoint: " + params.thermostatTemperatureSetpoint + " , againast temperatureRange, temperatureMin:" + hastemperatureMin + ", temperatureMax:" + temperatureMax);
									if (params.thermostatTemperatureSetpoint > temperatureMax || params.thermostatTemperatureSetpoint < temperatureMin){
										// Build valueOutOfRange error response
										validationStatus = false;
										logger.log('warn', "[GHome Exec API] Temperature valueOutOfRange error for endpointId:" + element.id);
										// Global error response
										var errResponse = {
											"requestId": req.body.requestId,
											"payload": {
												"errorCode": "valueOutOfRange"
											}
										}
										logger.log('debug', "[GHome Exec API] valueOutOfRange error response:" + JSON.stringify(errResponse));
										res.status(200).json(errResponse);
									}
								}
							}
							// Handle Color Temperature valueOutOfRange
							if (arrCommands[i].execution[0].command == "action.devices.commands.ColorAbsolute") {
								var hastemperatureMaxK = getSafe(() => data.attributes.colorTemperatureRange.temperatureMaxK);
								var hastemperatureMinK = getSafe(() => data.attributes.colorTemperatureRange.temperatureMinK);
								if (hastemperatureMinK != undefined && hastemperatureMaxK != undefined) {
									var temperatureMinK = data.attributes.colorTemperatureRange.temperatureMinK;
									var temperatureMaxK = data.attributes.colorTemperatureRange.temperatureMaxK;
									logger.log('debug', "[GHome Exec API] Checking requested setpoint: " + params.color.temperature + " , againast temperatureRange, temperatureMin:" + hastemperatureMin + ", temperatureMax:" + temperatureMax);
									if (params.color.temperature > temperatureMaxK || params.color.temperature < temperatureMinK){
										// Build valueOutOfRange error response
										validationStatus = false;
										logger.log('warn', "[GHome Exec API] valueOutOfRange error for endpointId:" + element.id);
										// Global error response
										var errResponse = {
											"requestId": req.body.requestId,
											"payload": {
												"errorCode": "valueOutOfRange"
											}
										}
										logger.log('debug', "[GHome Exec API] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
										res.status(200).json(errResponse);
									}
								}
							}
							if (validationStatus == true) {
								logger.log('debug', "[GHome Exec API] Command to be executed against endpointId:" + element.id);
								// Set MQTT Topic
								var topic = "command/" + req.user.username + "/" + element.id;
								try{
									// Define MQTT Message
									var message = JSON.stringify({
										requestId: requestId,
										id: element.id,
										execution: arrCommands[i]
									});
									mqttClient.publish(topic,message); // Publish Command
									logger.log('verbose', "[GHome Exec API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
									logger.log('debug', "[GHome Exec API] MQTT message:" + message);

								} catch (err) {
									logger.log('warn', "[GHome Exec API] Failed to publish MQTT command for user: " + req.user.username);
									logger.log('debug', "[GHome Exec API] Publish MQTT command error: " + err);
								}
								// Build success response and include in onGoingCommands
								var response = {
									requestId: requestId,
									payload: {
										commands: [{
											ids: [element.id],
											status: "SUCCESS",
											state: params
										}]
									}
								}
								var command = {
									user: req.user.username,
									res: res,
									response: response,
									source: "Google",
									timestamp: Date.now()
								};
								onGoingCommands[requestId] = command; // Command drops into buffer w/ 6000ms timeout (see defined funcitonm above) - ACK comes from N/R flow
							}
						});
					}
					if (debug == "true") {console.timeEnd('ghome-exec')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Exec API] Device not found");
					res.status(500).json({message: "Device not found"});
					if (debug == "true") {console.timeEnd('ghome-exec')};
				}
			}).catch(err => {
				logger.log('error', "[GHome Exec API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				if (debug == "true") {console.timeEnd('ghome-exec')};
			});

			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.QUERY' :
			logger.log('verbose', "[GHome Query API] Running device state query for user:" + req.user.username);

			var params = {
				ec: "QUERY",
				ea: "GHome QUERY event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			if (debug == "true") {console.time('ghome-query')};
			var findUser = Account.find({username: req.user.username});
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (user && devices) {
					var arrQueryDevices = req.body.inputs[0].payload.devices;
					var response = {
						"requestId": requestId,
						"payload": {
							"devices" : {}
						}
					}
					for (var i=0; i< arrQueryDevices.length; i++) {
						// Find device in array of user devices returned in promise
						logger.log('debug', "[GHome Query API] Trying to match requested device: " + arrQueryDevices[i].id + " with user-owned endpointId");	
						var data = devices.find(obj => obj.endpointId == arrQueryDevices[i].id);
						if (data) {
							logger.log('verbose', "[GHome Query API] Matched requested device: " + arrQueryDevices[i].id + " with user-owned endpointId: " + data.endpointId);	
							// Create initial JSON object for device
							response.payload.devices[data.endpointId] = {online: true};
							// Add state response based upon device traits
							data.capabilities.forEach(function(capability){
								var trait = gHomeReplaceCapability(capability);

								// Limit supported traits, add new ones here once SYNC and gHomeReplaceCapability function updated
								if (trait == "action.devices.traits.Brightness"){
									response.payload.devices[data.endpointId].brightness = data.state.brightness;
								}
								if (trait == "action.devices.traits.ColorSetting") {
									if (!response.payload.devices[data.endpointId].hasOwnProperty('on')){
										response.payload.devices[data.endpointId].on = data.state.power.toLowerCase();
									}
									if (data.capabilities.indexOf('ColorController') > -1 ){
										response.payload.devices[data.endpointId].color = {
											"spectrumHsv": {
												"hue": data.state.colorHue,
												"saturation": data.state.colorSaturation,
												"value": data.state.colorBrightness
											  }
										}
									}
									if (data.capabilities.indexOf('ColorTemperatureController') > -1){
										var hasColorElement = getSafe(() => response.payload.devices[data.endpointId].color);
										if (hasColorElement != undefined) {response.payload.devices[data.endpointId].color.temperatureK = data.state.colorTemperature}
										else {
											response.payload.devices[data.endpointId].color = {
												"temperatureK" : data.state.colorTemperature
											}
										}
									}
								}
								if (trait == "action.devices.traits.OnOff") {
									if (data.state.power.toLowerCase() == 'on') {
										response.payload.devices[data.endpointId].on = true;
									}
									else {
										response.payload.devices[data.endpointId].on = false;
									}
									
								}
								// if (trait == "action.devices.traits.Scene") {} // Only requires 'online' which is set above
								if (trait == "action.devices.traits.TemperatureSetting") {
									response.payload.devices[data.endpointId].thermostatMode = data.state.thermostatMode.toLowerCase();
									response.payload.devices[data.endpointId].thermostatTemperatureSetpoint = data.state.thermostatSetPoint;
									if (data.state.hasOwnProperty('temperature')) {
										response.payload.devices[data.endpointId].thermostatTemperatureAmbient = data.state.temperature;
									}
								}
							});
						}
						else {
							logger.log('warn', "[GHome Query API] Unable to match a requested device with user endpointId");
						}
					}
					// Send Response
					logger.log('verbose', "[GHome Query API] QUERY state: " + JSON.stringify(response));
					res.status(200).json(response);
					if (debug == "true") {console.timeEnd('ghome-query')};
				}
				else if (!user){
					logger.log('warn', "[GHome Query API] User not found");
					res.status(500).json({message: "User not found"});
					if (debug == "true") {console.timeEnd('ghome-query')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Query API] Device not found");
					res.status(500).json({message: "Device not found"});
					if (debug == "true") {console.timeEnd('ghome-query')};
				}

			}).catch(err => {
				logger.log('error', "[GHome Query API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				if (debug == "true") {console.timeEnd('ghome-query')};
			});
			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.DISCONNECT' : 
			// Find service definition with Google URLs
			var userId = req.user._id;
			var params = {
				ec: "DISCONNECT",
				ea: "GHome Disconnect event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			oauthModels.Application.findOne({domains: "oauth-redirect.googleusercontent.com" },function(err, data){
				if (data) {
					// Remove OAuth tokens for **Google Home** only
					logger.log('debug', "[GHome Disconnect API] Disconnect request for userId:" + userId + ", application:" + data.title);
					var grantCodes = oauthModels.GrantCode.deleteMany({user: userId, application: data._id});
					var accessTokens = oauthModels.AccessToken.deleteMany({user: userId, application: data._id});
					var refreshTokens = oauthModels.RefreshToken.deleteMany({user: userId, application: data._id});
					Promise.all([grantCodes, accessTokens, refreshTokens]).then(result => {
						logger.log('info', "[GHome Disconnect API] Deleted GrantCodes, RefreshToken and AccessTokens for user account: " + userId)
						res.status(200).send();
					}).catch(err => {
					 	logger.log('warn', "[GHome Disconnect API] Failed to delete GrantCodes, RefreshToken and AccessTokens for user account: " + userId);
					 	res.status(500).json({error: err});
					});
				}
			});
			break; 
	}
});

// Convert Alexa Device Capabilities to Google Home-compatible
function gHomeReplaceCapability(capability) {
	// Limit supported traits, add new ones here
	if(capability == "PowerController") {return "action.devices.traits.OnOff"}
	else if(capability == "BrightnessController")  {return "action.devices.traits.Brightness"}
	else if(capability == "ColorController" || capability == "ColorTemperatureController"){return "action.devices.traits.ColorSetting"}
	else if(capability == "SceneController") {return "action.devices.traits.Scene"}
	else if(capability == "ThermostatController")  {return "action.devices.traits.TemperatureSetting"}
	else {return "Not Supported"}
}

// Convert Alexa Device Types to Google Home-compatible
function gHomeReplaceType(type) {
	// Limit supported device types, add new ones here
	if (type == "ACTIVITY_TRIGGER") {return "action.devices.types.SCENE"}
	else if (type == "LIGHT") {return "action.devices.types.LIGHT"}
	else if (type == "SMARTPLUG") {return "action.devices.types.OUTLET"}
	else if (type == "SWITCH") {return "action.devices.types.SWITCH"}
	else if (type.indexOf('THERMOSTAT') > -1) {return "action.devices.types.THERMOSTAT"}
	else {return "NA"}
}
/////////////////////// End GHome


/////////////////////// Start Amazon

///////////////////////////////////////////////////////////////////////////
// Discovery API, can be tested via credentials of an account/ browsing to http://<hostname>/api/v1/devices
///////////////////////////////////////////////////////////////////////////
app.get('/api/v1/devices', defaultLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		var params = {
			ec: "Discovery",
			ea: "Running device discovery for username: " + req.user.username,
			uid: req.user.username,
			uip: req.ip,
			dp: "/api/v1/devices"
		  }
		if (enableAnalytics) {visitor.event(params).send()};

		var user = req.user.username
		Devices.find({username: user},function(error, data){
			if (!error) {
				logger.log('info', "[Discover API] Running device discovery for user:" + user);
				var devs = [];
				for (var i=0; i< data.length; i++) {
					var dev = {};
					dev.friendlyName = data[i].friendlyName;
					dev.description = data[i].description;
					dev.endpointId = "" + data[i].endpointId;
					dev.reportState = data[i].reportState;
					// Handle multiple capabilities, call replaceCapability to replace placeholder capabilities
					dev.capabilities = [];
					// Grab device attributes for use in building discovery response
					var devAttribues = (data[i].attributes || null);
					data[i].capabilities.forEach(function(capability){
						dev.capabilities.push(replaceCapability(capability, dev.reportState, devAttribues))
					});
					dev.displayCategories = data[i].displayCategories;
					dev.cookie = data[i].cookie;
					dev.version = "0.0.3";
					dev.manufacturerName = "Node-RED"
					devs.push(dev);
				}
				//console.log(devs)
				res.send(devs);
			}	
		});
	}
);

// Replace Capability function, replaces 'placeholders' stored under device.capabilities in mongoDB with Amazon JSON
function replaceCapability(capability, reportState, attributes) {
	// BrightnessController
	if(capability == "BrightnessController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.BrightnessController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "brightness"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// ChannelController
	if(capability == "ChannelController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.ChannelController",
			"version": "3",
			};
	}
	// ColorController
	if(capability == "ColorController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.ColorController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "color"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// ColorTemperatureController
	if(capability == "ColorTemperatureController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.ColorTemperatureController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "colorTemperatureInKelvin"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// InputController, pre-defined 4x HDMI inputs and phono
	if(capability == "InputController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.InputController",
			"version": "3",
			"inputs": [{
				"name": "HDMI1"
			  },
			  {
				"name": "HDMI2"
			  },
			  {
				"name": "HDMI3"
			  },
			  {
				"name": "HDMI4"
			  },
			  {
				"name": "phono"
			  },
			  {
				"name": "audio1"
			  },
			  {
				"name": "audio2"
			  },
			  {
				"name": "chromecast"
			  }
			]};
	}
	// LockController
	if(capability == "LockController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.LockController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "lockState"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// PercentageController
	if(capability == "PercentageController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PercentageController",
			"version": "3",
			"properties": {
				"supported": [{
					"name": "percentage"
				}],
				"proactivelyReported": false,
				"retrievable": reportState
			}
		};
	}
	// PlaybackController
	if(capability == "PlaybackController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PlaybackController",
			"version": "3",
			"supportedOperations" : ["Play", "Pause", "Stop", "FastForward", "StartOver", "Previous", "Rewind", "Next"]
			};
	}
	// PowerController
	if(capability == "PowerController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PowerController",
			"version": "3",
			"properties": {
				"supported": [{
					"name": "powerState"
				}],
				"proactivelyReported": false,
				"retrievable": reportState
				}
			};
	}
	// Speaker
	if(capability == "Speaker") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.Speaker",
			"version": "3",
			"properties":{
				"supported":[{
						"name":"volume"
					},
					{
						"name":"muted"
					}
				]}
			};
	}
	// SceneController 
	if(capability == "SceneController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.SceneController",
			"version" : "3",
			"supportsDeactivation" : false
			};
	}
	// StepSpeaker
	if(capability == "StepSpeaker") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.StepSpeaker",
			"version": "3",
			"properties":{
				"supported":[{
					  "name":"volume"
				   },
				   {
					  "name":"muted"
				   }
				]}
			};
	}
	// TemperatureSensor 
	if(capability == "TemperatureSensor") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.TemperatureSensor",
			"version" : "3",
			"properties": {
                "supported": [
                  {
                    "name": "temperature"
                  }
                ],
                "proactivelyReported": false,
                "retrievable": true
              }
			};
	}
	// ThermostatController - SinglePoint
	if(capability == "ThermostatController")  {
		var supportedModes;
		var hasModes = getSafe(() => attributes.thermostatModes);
		if (attributes != null && hasModes != undefined) {
			supportedModes = attributes.thermostatModes;
		}
		else {
			supportedModes = ["HEAT","COOL","AUTO"];
		}
		return {
			"type": "AlexaInterface",
            "interface": "Alexa.ThermostatController",
            "version": "3",
            "properties": {
              "supported": [{
                  "name": "targetSetpoint"
                },
                {
                  "name": "thermostatMode"
                }
              ],
			  "proactivelyReported": false,
			  "retrievable": reportState
            },
            "configuration": {
              "supportsScheduling": true,
              "supportedModes": supportedModes
			}
		};
	}
};

///////////////////////////////////////////////////////////////////////////
// MQTT Message Handlers
///////////////////////////////////////////////////////////////////////////
var onGoingCommands = {};

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/"); 
	var username = arrTopic[1];
	var endpointId = arrTopic[2];

	if (topic.startsWith('response/')){
		logger.log('info', "[Command API] Acknowledged MQTT response message for topic: " + topic);
		if (debug == "true") {console.time('mqtt-response')};
		var payload = JSON.parse(message.toString());
		//console.log("response payload", payload)
		var commandWaiting = onGoingCommands[payload.messageId];
		if (commandWaiting) {
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				// Google Home success response
				if (commandWaiting.hasOwnProperty('source') && commandWaiting.source == "Google") {
					logger.log('debug', "[Command API] Successful Google Home MQTT command, response: " + JSON.stringify(commandWaiting.response));
					commandWaiting.res.status(200).json(commandWaiting.response);
				}
				// Alexa success response send to Lambda for full response construction
				else {
					if (commandWaiting.hasOwnProperty('response')) {
						logger.log('debug', "[Command API] Successful Alexa MQTT command, response: " + JSON.stringify(commandWaiting.response));
						commandWaiting.res.status(200).json(commandWaiting.response)
					}
					else {
						logger.log('debug', "[Command API] Alexa MQTT command successful");
						commandWaiting.res.status(200).send()
					}
				}			
			} else {
				// Google Home failure response
				if (commandWaiting.hasOwnProperty('source') && commandWaiting.source == "Google") {
					delete commandWaiting.response.state;
					commandWaiting.response.status = "FAILED";
					logger.log('warn', "[Command API] Failed Google Home MQTT command, response: " + JSON.stringify(commandWaiting.response));
					commandWaiting.res.status(200).json(commandWaiting.response);
				}
				// Alexa failure response send to Lambda for full response construction
				else {
					if (commandWaiting.hasOwnProperty('response')) {
						logger.log('warn', "[Command API] Failed Alexa MQTT Command API, response:" + + JSON.stringify(commandWaiting.response));
						commandWaiting.res.status(503).json(commandWaiting.response)
					}
					else {
						logger.log('warn', "[Command API] Failed Alexa MQTT Command API response");
						commandWaiting.res.status(503).send()
					}
				}
			}
			delete onGoingCommands[payload.messageId];
			var params = {
				ec: "Command",
				ea: "Command API successfully processed MQTT command for username: " + username,
				uid: username,
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
		if (debug == "true") {console.timeEnd('mqtt-response')};
	}
	else if (topic.startsWith('state/')){
		logger.log('info', "[State API] Acknowledged MQTT state message topic: " + topic);
		if (debug == "true") {console.time('mqtt-state')};
		// Split topic/ get username and endpointId
		var messageJSON = JSON.parse(message);
		var payload = messageJSON.payload;
		// Call setstate to update attribute in mongodb
		setstate(username,endpointId,payload) //arrTopic[1] is username, arrTopic[2] is endpointId
		// Add message to onGoingCommands
		var stateWaiting = onGoingCommands[payload.messageId];
		if (stateWaiting) {
			if (payload.success) {
				logger.log('info', "[State API] Succesful MQTT state update for user:" + username + " device:" + endpointId);
				stateWaiting.res.status(200).send();
			} else {
				logger.log('warn', "[State API] Failed MQTT state update for user:" + username + " device:" + endpointId);
				stateWaiting.res.status(503).send();
			}
		}
		// If successful remove messageId from onGoingCommands
		delete onGoingCommands[payload.messageId];
		var params = {
			ec: "Set State",
			ea: "State API successfully processed MQTT state for username: " + username + " device: " + endpointId,
			uid: username,
		  }
		if (enableAnalytics) {visitor.event(params).send()};
		if (debug == "true") {console.timeEnd('mqtt-state')};
	}
	else {
		logger.log('debug', "[MQTT] Unhandled MQTT via on message event handler: " + topic + message);
	}
});

// Interval funciton, runs every 500ms once defined via setInterval: https://www.w3schools.com/js/js_timing.asp
var timeout = setInterval(function(){
	var now = Date.now();
	var keys = Object.keys(onGoingCommands);
	for (key in keys){
		var waiting = onGoingCommands[keys[key]];
		logger.log('debug', "[MQTT] Queued MQTT message: " + keys[key]);
		if (waiting) {
			var diff = now - waiting.timestamp;
			if (diff > 6000) {
				logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged: " + keys[key]);
				waiting.res.status(504).send('{"error": "timeout"}');
				delete onGoingCommands[keys[key]];
				//measurement.send({
				//	t:'event', 
				//	ec:'command', 
				//	ea: 'timeout',
				//	uid: waiting.user
				//});
			}
		}
	}
},500);

///////////////////////////////////////////////////////////////////////////
// Get State API
///////////////////////////////////////////////////////////////////////////
app.get('/api/v1/getstate/:dev_id', getStateLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		var id = req.params.dev_id;

		var params = {
			ec: "Get State",
			ea: "GetState API request for username: " + req.user.username + ", endpointId: " + id,
			uid: req.user.username,
			uip: req.ip,
			dp: "/api/v1/getstate"
		  }
		if (enableAnalytics) {visitor.event(params).send()};

		// Identify device, we know who user is from request
		logger.log('debug', "[State API] Received GetState API request for user:" + req.user.username + " endpointId:" + id);

		Devices.findOne({username:req.user.username, endpointId:id}, function(err, data){
			if (err) {
				logger.log('warn',"[State API] No device found for username: " + req.user.username + " endpointId:" + id);
				res.status(500).send();
			}
			if (data) {
				var deviceJSON = JSON.parse(JSON.stringify(data)); // Convert "model" object class to JSON object so that properties are query-able
				if (deviceJSON && deviceJSON.hasOwnProperty('reportState')) {
					if (deviceJSON.reportState = true) { // Only respond if device element 'reportState' is set to true
						if (deviceJSON.hasOwnProperty('state')) {
								// Inspect state element and build response based upon device type /state contents
								// Will need to group multiple states into correct update format
								var properties = [];
								
								deviceJSON.capabilities.forEach(function(capability) {
									switch (capability)  {
										case "BrightnessController":
											// Return brightness percentage
											if (deviceJSON.state.hasOwnProperty('brightness') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.BrightnessController",
														"name": "brightness",
														"value": deviceJSON.state.brightness,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "ChannelController":
											// Return Channel State - no reportable state as of December 2018
											break;
										case "ColorController":
											// Return color
											if (deviceJSON.state.hasOwnProperty('colorHue') && deviceJSON.state.hasOwnProperty('colorSaturation') && deviceJSON.state.hasOwnProperty('colorBrightness') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.ColorController",
														"name": "color",
														"value": {
															"hue": deviceJSON.state.colorHue,
															"saturation": deviceJSON.state.colorSaturation,
															"brightness": deviceJSON.state.colorBrightness
														},
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
														});
												}
											break;
										case "ColorTemperatureController":
											// Return color temperature
											if (deviceJSON.state.hasOwnProperty('colorTemperature') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.ColorTemperatureController",
														"name": "colorTemperatureInKelvin",
														"value": deviceJSON.state.colorTemperature,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "InputController":
											// Return Input
											if (deviceJSON.state.hasOwnProperty('input') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.InputController",
														"name": "input",
														"value": deviceJSON.state.input,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "LockController":
											// Return Lock State
											if (deviceJSON.state.hasOwnProperty('lock') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.LockController",
														"name": "lockState",
														"value": deviceJSON.state.lock,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "PlaybackController":
											// Return Playback State - no reportable state as of November 2018
											break;
										case "PercentageController":
											// Return Power State
											if (deviceJSON.state.hasOwnProperty('percentage') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
															"namespace": "Alexa.PercentageController",
															"name": "percentage",
															"value": deviceJSON.state.percentage,
															"timeOfSample": deviceJSON.state.time,
															"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "PowerController":
											// Return Power State
											if (deviceJSON.state.hasOwnProperty('power') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
															"namespace": "Alexa.PowerController",
															"name": "powerState",
															"value": deviceJSON.state.power,
															"timeOfSample": deviceJSON.state.time,
															"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "TemperatureSensor":
											// Return temperature
											if (deviceJSON.state.hasOwnProperty('temperature') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
													"namespace": "Alexa.TemperatureSensor",
													"name": "temperature",
													"value": {
														"value": deviceJSON.state.temperature,
														"scale": deviceJSON.attributes.temperatureScale.toUpperCase()
													  },
													"timeOfSample": deviceJSON.state.time,
													"uncertaintyInMilliseconds": 10000
												});
											}
											break;
										case "ThermostatController":
											// Return thermostatSetPoint
											if (deviceJSON.state.hasOwnProperty('thermostatSetPoint') && deviceJSON.state.hasOwnProperty('thermostatMode') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace":"Alexa.ThermostatController",
														"name":"targetSetpoint",
														"value":{  
															"value":deviceJSON.state.thermostatSetPoint,
															"scale":deviceJSON.attributes.temperatureScale.toUpperCase()
															},
														"timeOfSample":deviceJSON.state.time,
														"uncertaintyInMilliseconds":10000
													});
												properties.push({
														"namespace":"Alexa.ThermostatController",
														"name":"thermostatMode",
														"value":deviceJSON.state.thermostatMode,
														"timeOfSample":deviceJSON.state.time,
														"uncertaintyInMilliseconds":10000
													});
											}
											break;
									}
								});
								
								properties.push({
									"namespace": "Alexa.EndpointHealth",
									"name": "connectivity",
									"value": {
									  "value": "OK"
									},
									"timeOfSample": deviceJSON.state.time,
									"uncertaintyInMilliseconds": 10000
								});
								logger.log('debug', "[State API] State response properties: " + JSON.stringify(properties));
								res.status(200).json(properties);
								}
							else {
								// Device has no state, return as such
								logger.log('warn',"[State API] No state found for username: " + req.user.username + " endpointId:" + id);
								res.status(500).send();
							}
						}
						// State reporting not enabled for device, send error code
						else {
							logger.log('debug',"[State API] State requested for user: " + req.user.username + " device: " + id +  " but device state reporting disabled");
							var properties = [];
							properties.push({
								"namespace": "Alexa.EndpointHealth",
								"name": "connectivity",
								"value": {
								  "value": "OK"
								},
								"timeOfSample": deviceJSON.state.time,
								"uncertaintyInMilliseconds": 10000
							});

							//res.status(500).send();
							res.status(200).json(properties);
						}
					}
					// 'reportState' element missing on device, send error code
					else {
						logger.log('warn', "[State API] User: " + req.user.username + " device: " + id +  " has no reportState attribute, check MongoDB schema");
						res.status(500).send();
					}
				}
		});
 	}
);

///////////////////////////////////////////////////////////////////////////
// Set State API (Not in Use)
///////////////////////////////////////////////////////////////////////////
app.post('/api/v1/setstate/:dev_id',
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		// do nothing, disused for now, may use along side command API 
	}
);

///////////////////////////////////////////////////////////////////////////
// Alexa Command API
///////////////////////////////////////////////////////////////////////////
/* app.post('/api/v1/command',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		//console.log(req.user.username);
		//console.log(req);
		var params = {
			ec: "Command",
			ea: req.body.directive.header ? "Command API directive:" + req.body.directive.header.name + ", username: " + req.user.username + ", endpointId:" + req.body.directive.endpoint.endpointId : "Command API directive",
			uid: req.user.username,
			uip: req.ip,
			dp: "/api/v1/command"
		  }
		if (enableAnalytics) {visitor.event(params).send()};

		Devices.findOne({username:req.user.username, endpointId:req.body.directive.endpoint.endpointId}, function(err, data){
			if (err) {
				logger.log('warn', "[Command API] Unable to lookup device: " + req.body.directive.endpoint.endpointId + " for user: " + req.user.username);
				res.status(404).send();	
			}
			if (data) {
				// Convert "model" object class to JSON object
				var deviceJSON = JSON.parse(JSON.stringify(data));
				var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
				var validationStatus = true;
				// Cleanup MQTT message
				delete req.body.directive.header.correlationToken;
				delete req.body.directive.endpoint.scope.token;
				var message = JSON.stringify(req.body);
				logger.log('debug', "[Command API] Received command API request for user: " + req.user.username + " command: " + message);
				// Check attributes.colorTemperatureRange, send 417 to Lambda (VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ColorTemperatureController" && req.body.directive.header.name == "SetColorTemperature") {
					var compare = req.body.directive.payload.colorTemperatureInKelvin;
					// Handle Out of Range
					if (deviceJSON.hasOwnProperty('attributes')) {
						if (deviceJSON.attributes.hasOwnProperty('colorTemperatureRange')) {
							if (compare < data.attributes.colorTemperatureRange.temperatureMinK || compare > data.attributes.colorTemperatureRange.temperatureMaxK) {
								logger.log('warn', "[Command API] User: " + req.user.username + ", requested color temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(data.attributes.colorTemperatureRange));
								res.status(417).send();
								validationStatus = false;
							}
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have data.attributes.colorTemperatureRange defined")}
				}

				// Check attributes.temperatureRange, send 416 to Lambda (TEMPERATURE_VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ThermostatController" && req.body.directive.header.name == "SetTargetTemperature") {
					var compare = req.body.directive.payload.targetSetpoint.value;
					// Handle Temperature Out of Range
					if (deviceJSON.hasOwnProperty('attributes')) {
						if (deviceJSON.attributes.hasOwnProperty('temperatureRange')) {
							if (compare < data.attributes.temperatureRange.temperatureMin || compare > data.attributes.temperatureRange.temperatureMax) {
								logger.log('warn', "[Command API] User: " + req.user.username + ", requested temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(data.attributes.temperatureRange));
								res.status(416).send();
								validationStatus = false;
							}
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have data.attributes.temperatureRange defined")}
				}
				
				if (validationStatus) {
					try{
						mqttClient.publish(topic,message);
						logger.log('info', "[Command API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
					} catch (err) {
						logger.log('warn', "[Command API] Failed to publish MQTT command for user: " + req.user.username);
					}
					var command = {
						user: req.user.username,
						res: res,
						source: "Alexa",
						timestamp: Date.now()
					};
			
					// Command drops into buffer w/ 6000ms timeout (see defined funcitonm above) - ACK comes from N/R flow
					onGoingCommands[req.body.directive.header.messageId] = command;
				}
			}
		});
	}
);
 */

///////////////////////////////////////////////////////////////////////////
// Start Alexa Command API v2 (replaces much of the Lambda functionality)
///////////////////////////////////////////////////////////////////////////
app.post('/api/v1/command2',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		var params = {
			ec: "Command",
			ea: req.body.directive.header ? "Command API directive:" + req.body.directive.header.name + ", username: " + req.user.username + ", endpointId:" + req.body.directive.endpoint.endpointId : "Command API directive",
			uid: req.user.username,
			uip: req.ip,
			dp: "/api/v1/command"
		  }
		if (enableAnalytics) {visitor.event(params).send()};

		Devices.findOne({username:req.user.username, endpointId:req.body.directive.endpoint.endpointId}, function(err, data){
			if (err) {
				logger.log('warn', "[Command API] Unable to lookup device: " + req.body.directive.endpoint.endpointId + " for user: " + req.user.username);
				res.status(404).send();	
			}
			if (data) {
				//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
				// Revised Command API Router, offloading from Lambda to avoid multiple requests/ data comparison
				//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
				logger.log('debug', "[Command API] Received command: " + JSON.stringify(req.body));
				// Convert "model" object class to JSON object
				var deviceJSON = JSON.parse(JSON.stringify(data));
				var endpointId = req.body.directive.endpoint.endpointId;
				var messageId = req.body.directive.header.messageId;
				var oauth_id = req.body.directive.endpoint.scope.token;
				var correlationToken = req.body.directive.header.correlationToken;
				var dt = new Date();
				var name = req.body.directive.header.name;
				var namespace = req.body.directive.header.namespace;
				// Build Header
				var header = {
					"namespace": "Alexa",
					"name": "Response",
					"payloadVersion": "3",
					"messageId": messageId + "-R",
					"correlationToken": correlationToken
				}
				// Build Default Endpoint Response
				var endpoint = {
					"scope": {
						"type": "BearerToken",
						"token": oauth_id
					},
					"endpointId": endpointId
				}
				// Build Brightness Controller Response Context
				if (namespace == "Alexa.BrightnessController" && (name == "AdjustBrightness" || name == "SetBrightness")) {
					if (name == "AdjustBrightness") {
						var brightness;
						if (req.body.directive.payload.brightnessDelta < 0) {
							brightness = req.body.directive.payload.brightnessDelta + 100;
						}
						else {
							brightness = req.body.directive.payload.brightnessDelta;
						}
						// Return Percentage Delta (NOT in-line with spec)
						var contextResult = {
							"properties": [{
								"namespace" : "Alexa.BrightnessController",
								"name": "brightness",
								"value": brightness,
								"timeOfSample": dt.toISOString(),
								"uncertaintyInMilliseconds": 50
							}]
						};

					}
					if (name == "SetBrightness") {
						// Return Percentage
						var contextResult = {
							"properties": [{
								"namespace" : "Alexa.BrightnessController",
								"name": "brightness",
								"value": req.body.directive.payload.brightness,
								"timeOfSample": dt.toISOString(),
								"uncertaintyInMilliseconds": 50
							}]
						}                
					};
				}
				// Build Channel Controller Response Context
				if (namespace == "Alexa.ChannelController") {
					if (name == "ChangeChannel") { 
						if (req.body.directive.payload.channel.hasOwnProperty('number')) {
							var contextResult = {
							"properties": [
								{
								"namespace": "Alexa.ChannelController",
								"name": "channel",
								"value": {
									"number": req.body.directive.payload.channel.number
								},
								"timeOfSample": dt.toISOString(),
								"uncertaintyInMilliseconds": 50
								}
							]}
						}
						else if (req.body.directive.payload.channel.hasOwnProperty('callSign')) {
							var contextResult = {
								"properties": [
									{
									"namespace": "Alexa.ChannelController",
									"name": "channel",
									"value": {
										"callSign": req.body.directive.payload.channel.callSign                                
									},
									"timeOfSample": dt.toISOString(),
									"uncertaintyInMilliseconds": 50
									}
								]}
						}
					}
				}
				// ColorController
				if (namespace == "Alexa.ColorController") {
					var contextResult = {
						"properties": [{
							"namespace" : "Alexa.ColorController",
							"name": "color",
							"value": {
								"hue": req.body.directive.payload.color.hue,
								"saturation": req.body.directive.payload.color.saturation,
								"brightness": req.body.directive.payload.color.brightness
							},
							"timeOfSample": dt.toISOString(),
							"uncertaintyInMilliseconds": 50
						}]
					};
				}
				// Build ColorTemperatureController Response Context
				if (namespace == "Alexa.ColorTemperatureController") {
					var strPayload = req.body.directive.payload.colorTemperatureInKelvin;
					var colorTemp;
					if (typeof strPayload != 'number') {
						if (strPayload == "warm" || strPayload == "warm white") {colorTemp = 2200};
						if (strPayload == "incandescent" || strPayload == "soft white") {colorTemp = 2700};
						if (strPayload == "white") {colorTemp = 4000};
						if (strPayload == "daylight" || strPayload == "daylight white") {colorTemp = 5500};
						if (strPayload == "cool" || strPayload == "cool white") {colorTemp = 7000};
					}
					else {
						colorTemp = req.body.directive.payload.colorTemperatureInKelvin;
					}
					var contextResult = {
						"properties": [{
							"namespace" : "Alexa.ColorTemperatureController",
							"name": "colorTemperatureInKelvin",
							"value": colorTemp,
							"timeOfSample": dt.toISOString(),
							"uncertaintyInMilliseconds": 50
						}]
					}
				}
				// Build Input Controller Response Context
				if (namespace == "Alexa.InputController") {
					var contextResult = {
						"properties": [{
							"namespace" : "Alexa.InputController",
							"name": "input",
							"value": req.body.directive.payload.input,
							"timeOfSample": dt.toISOString(),
							"uncertaintyInMilliseconds": 50
						}]
					}
					endpoint = {
						"endpointId": endpointId
					}
				}
				// Build Lock Controller Response Context - SetThermostatMode
				if (namespace == "Alexa.LockController") {
					var lockState;
					if (name == "Lock") {lockState = "LOCKED"};
					if (name == "Unlock") {lockState = "UNLOCKED"};
					var contextResult = {
						"properties": [{
						"namespace": "Alexa.LockController",
						"name": "lockState",
						"value": lockState,
						"timeOfSample": dt.toISOString(),
						"uncertaintyInMilliseconds": 500
						}]
					};
				}
				// Build PercentageController Response Context
				if (namespace == "Alexa.PercentageController") {
					if (name == "SetPercentage") {
						var contextResult = {
							"properties": [{
								"namespace": "Alexa.PercentageController",
								"name": "percentage",
								"value": req.body.directive.payload.percentage,
								"timeOfSample": dt.toISOString(),
								"uncertaintyInMilliseconds": 500
							}]
						};
					}
					if (name == "AdjustPercentage") {
						var percentage;
						var hasPercentage = getSafe(() => deviceJSON.state.percentage);
						if (hasPercentage != undefined) {
							if (deviceJSON.state.percentage + req.body.directive.payload.percentageDelta > 100) {percentage = 100}
							else if (deviceJSON.state.percentage - req.body.directive.payload.percentageDelta < 0) {percentage = 0}
							else {percentage = deviceJSON.state.percentage + req.body.directive.payload.percentageDelta}
							var contextResult = {
								"properties": [{
									"namespace": "Alexa.PercentageController",
									"name": "percentage",
									"value": percentage,
									"timeOfSample": dt.toISOString(),
									"uncertaintyInMilliseconds": 500
									}]
								};
							}
					}
				}
				// Build PlaybackController Response Context
				if (namespace == "Alexa.PlaybackController") {
					var contextResult = {
						"properties": []
					};
				}
				// Build PowerController Response Context
				if (namespace == "Alexa.PowerController") {
					if (name == "TurnOn") {var newState = "ON"};
					if (name == "TurnOff") {var newState = "OFF"};
					var contextResult = {
						"properties": [{
							"namespace": "Alexa.PowerController",
							"name": "powerState",
							"value": newState,
							"timeOfSample": dt.toISOString(),
							"uncertaintyInMilliseconds": 50
						}]
					};
				}
				// Build Scene Controller Activation Started Event
				if (namespace == "Alexa.SceneController") {
					header.namespace = "Alexa.SceneController";
					header.name = "ActivationStarted";
					var contextResult = {};
					var payload = {
							"cause" : {
								"type" : "VOICE_INTERACTION"
								},
							"timestamp": dt.toISOString()
							};
				}
				// Build Speaker Response Context
				if (namespace == "Alexa.Speaker") {
					if (name == "SetVolume") {
						var contextResult = {
							"properties": [
								{
								"namespace": "Alexa.Speaker",
								"name": "volume",
								"value":  req.body.directive.payload.volume,
								"timeOfSample": dt.toISOString(),
								"uncertaintyInMilliseconds": 50
								}
							]}
						}
					else if (name == "SetMute") {
						var contextResult = {
							"properties": [
								{
									"namespace": "Alexa.Speaker",
									"name": "muted",
									"value": req.body.directive.payload.mute,
									"timeOfSample": dt.toISOString(),
									"uncertaintyInMilliseconds": 50
								}
							]}
					}
					else {
						var contextResult = {
							"properties": []
						};
					}
				}
				// Build StepSpeaker Response Context
				if (namespace == "Alexa.StepSpeaker") {
					var contextResult = {
						"properties": []
						};
				}
				//Build Thermostat Controller Response Context - AdjustTargetTemperature/ SetTargetTemperature
				if (namespace == "Alexa.ThermostatController" 
					&& (name == "AdjustTargetTemperature" || name == "SetTargetTemperature" || name == "SetThermostatMode")) {
					// Workout new targetSetpoint
					if (name == "AdjustTargetTemperature") {
						var newTemp, scale, newMode;
						// Workout values for targetTemperature
						var hasthermostatSetPoint = getSafe(() => deviceJSON.state.thermostatSetPoint);
						var hasTemperatureScale  = getSafe(() => deviceJSON.attributes.temperatureScale);
						if (hasthermostatSetPoint != undefined){newTemp = deviceJSON.state.thermostatSetPoint + req.body.directive.payload.targetSetpointDelta.value}
						else {newTemp = req.body.directive.payload.targetSetpointDelta.value}
						if (hasTemperatureScale != undefined){scale = deviceJSON.attributes.temperatureScale}
						else {scale = req.body.directive.payload.targetSetpointDelta.scale}
					}
					else if (name == "SetTargetTemperature") { // Use command-supplied fields
						newTemp = req.body.directive.payload.targetSetpoint.value;
						sclae = req.body.directive.payload.targetSetpoint.scale;
					}
					// Workout new thermostatMode
					var hasThermostatModes = getSafe(() => deviceJSON.attributes.thermostatModes);
					if (hasThermostatModes != undefined){
						var countModes = deviceJSON.attributes.thermostatModes.length;
						var arrModes = deviceJSON.attributes.thermostatModes;
						if (countModes == 1){ // If single mode is supported leave as-is
							newMode = deviceJSON.state.thermostatMode;
						}
						else {
							var auto, heat, cool, on, off = false;
							if (arrModes.indexOf('AUTO') > -1){auto = true};
							if (arrModes.indexOf('HEAT') > -1){heat = true};
							if (arrModes.indexOf('COOL') > -1){cool = true};
							if (arrModes.indexOf('ON') > -1){on = true};
							if (arrModes.indexOf('OFF') > -1){off = true};
							if (countModes == 2 && (on && off)) { // On and Off Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "OFF"}
								else {newMode = "ON"}
							}
							else if (countModes == 2 && (heat && cool)) { // Cool and Heat Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "COOL"}
								else {newMode = "HEAT"}
							}
							else if (countModes == 3 && (heat && cool && auto)) { // Heat, Cool and Auto Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "COOL"}
								else {newMode = "HEAT"}
							}
							else if (countModes == 5 && (on && off && on && off && auto)) { // All Modes Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "COOL"}
								else {newMode = "HEAT"}
							}
							else { // Fallback position
								newMode = "HEAT";
							}
						}
					}
					else {
						newMode = "HEAT";
					}
					var targetSetPointValue = {
						"value": newTemp,
						"scale": scale
					};
					var contextResult = {
						"properties": [{
							"namespace": "Alexa.ThermostatController",
							"name": "targetSetpoint",
							"value": targetSetPointValue,
							"timeOfSample": dt.toISOString(),
							"uncertaintyInMilliseconds": 50
						},
						{
							"namespace": "Alexa.ThermostatController",
							"name": "thermostatMode",
							"value": newMode,
							"timeOfSample": dt.toISOString(),
							"uncertaintyInMilliseconds": 50
						},
						{
							"namespace": "Alexa.EndpointHealth",
							"name": "connectivity",
							"value": {
								"value": "OK"
							},
							"timeOfSample": dt.toISOString(),
							"uncertaintyInMilliseconds": 50
						}]
					};
				}
				// Build Thermostat Controller Response Context - SetThermostatMode
				if (namespace == "Alexa.ThermostatController" && name == "SetThermostatMode") {
					var contextResult = {
						"properties": [{
						"namespace": "Alexa.ThermostatController",
						"name": "thermostatMode",
						"value": req.body.directive.payload.thermostatMode.value,
						"timeOfSample": dt.toISOString(),
						"uncertaintyInMilliseconds": 500
					}]
					};
				}
				// Default Response Format (payload is empty)
				if (namespace != "Alexa.SceneController"){
					// Compile Final Response Message
					var response = {
						context: contextResult,
						event: {
						header: header,
						endpoint: endpoint,
						payload: {}
						}
					};
				}
				// SceneController Specific Event
				else {
					var response = {
						context: contextResult,
						event: {
						header: header,
						endpoint: endpoint,
						payload: payload
						}
					};                
				}

				logger.log('debug', "[Command API] Command response:" + response);

				// Prepare MQTT topic/ message validation
				var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
				var validationStatus = true;

				// Cleanup MQTT message
				delete req.body.directive.header.correlationToken;
				delete req.body.directive.endpoint.scope.token;
				var message = JSON.stringify(req.body);
				logger.log('debug', "[Command API] Received command API request for user: " + req.user.username + " command: " + message);

				//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

				// Check attributes.colorTemperatureRange, send 417 to Lambda (VALUE_OUT_OF_RANGE) response if values are out of range
				if (namespace == "Alexa.ColorTemperatureController" && name == "SetColorTemperature") {
					var compare = req.body.directive.payload.colorTemperatureInKelvin;
					// Handle Out of Range
					var hasColorTemperatureRange = getSafe(() => deviceJSON.attributes.colorTemperatureRange);
					if (hasColorTemperatureRange != undefined) {
						if (compare < deviceJSON.attributes.colorTemperatureRange.temperatureMinK || compare > deviceJSON.attributes.colorTemperatureRange.temperatureMaxK) {
							logger.log('warn', "[Command API] User: " + req.user.username + ", requested color temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.colorTemperatureRange));
							// Send 417 HTTP code back to Lamnda, Lambda will send correct error message to Alexa
							res.status(417).send();
							validationStatus = false;
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.colorTemperatureRange defined")}
				}

				// Check attributes.temperatureRange, send 416 to Lambda (TEMPERATURE_VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ThermostatController" && req.body.directive.header.name == "SetTargetTemperature") {
					var compare = req.body.directive.payload.targetSetpoint.value;
					// Handle Temperature Out of Range
					var hasTemperatureRange = getSafe(() => deviceJSON.attributes.temperatureRange);
					if (hasTemperatureRange != undefined) {
						if (compare < deviceJSON.attributes.temperatureRange.temperatureMin || compare > deviceJSON.attributes.temperatureRange.temperatureMax) {
							logger.log('warn', "[Command API] User: " + req.user.username + ", requested temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.temperatureRange));
							// Send 416 HTTP code back to Lamnda, Lambda will send correct error message to Alexa
							res.status(416).send();
							validationStatus = false;
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.temperatureRange defined")}
				}
				
				if (validationStatus) {
					try{
						mqttClient.publish(topic,message);
						logger.log('info', "[Command API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
					} catch (err) {
						logger.log('warn', "[Command API] Failed to publish MQTT command for user: " + req.user.username);
					}
					var command = {
						user: req.user.username,
						res: res,
						response: response,
						source: "Alexa",
						timestamp: Date.now()
					};
			
					// Command drops into buffer w/ 6000ms timeout (see defined funcitonm above) - ACK comes from N/R flow
					onGoingCommands[req.body.directive.header.messageId] = command;
				}
			}
		});
	}
);
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// End Command API v2
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

app.get('/my-account', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var view = {
			dp: req.path, 
			dh: 'https://' + process.env.WEB_HOSTNAME,
			dt: 'My Account',
			uid: req.user.username,
			uip: req.ip,
			ua: req.headers['user-agent']
		}
		if (enableAnalytics) {visitor.pageview(view).send()};

		const user = Account.findOne({username: req.user.username});
		Promise.all([user]).then(([userAccount]) => {
			//logger.log('info', "userAccount: " + userAccount);
			res.render('pages/account',{user: userAccount, acc: true});
		}).catch(err => {
			res.status(500).json({error: err});
		});
});

app.get('/devices', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var view = {
			dp: req.path, 
			dh: 'https://' + process.env.WEB_HOSTNAME,
			dt: 'Devices',
			uid: req.user.username,
			uip: req.ip,
			ua: req.headers['user-agent']
		}
		if (enableAnalytics) {visitor.pageview(view).send()};
		var user = req.user.username;
		const userDevices = Devices.find({username:user});
		const countDevices = Devices.countDocuments({username:user});
		const countGrants = Account.aggregate([
			{ "$match": {
				"username" : user
			}},
			{ "$lookup": {
				"from": "grantcodes",
				"let": { "user_id": "$_id" },
				"pipeline": [
					{ "$match": {
					"$expr": { "$eq": [ "$$user_id", "$user" ] }
					}},
					{ "$count": "count" }
				],
				"as": "grantCount"    
			}},
			{ "$addFields": {
			"countGrants": { "$sum": "$grantCount.count" }
			}}
		]);

		Promise.all([userDevices, countDevices, countGrants]).then(([devices, countDevs, countUserGrants]) => {
			//logger.log('info', "Grant count for user: " + user + ", grants: " + countUserGrants[0].countGrants);
			//logger.log('info', "countUserGrants: " + JSON.stringify(countUserGrants));
			res.render('pages/devices',{user: req.user, devices: devices, count: countDevs, grants: countUserGrants[0].countGrants, devs: true});
		}).catch(err => {
			res.status(500).json({error: err});
		});
});

app.put('/devices', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var device = req.body;
		device.username = user;
		//device.isReachable = true;
		var dev = new Devices(device);
		dev.save(function(err, dev){
			if (!err) {
				res.status(201)
				res.send(dev);
				logger.log('debug', "[Devices] New device created: " + JSON.stringify(dev));
				if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
			} else {
				res.status(500);
				res.send(err);
			}
		});

});

app.post('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.body;
		if (req.user.username === mqtt_user || req.user.username == user.username) { // Check is admin user, or user themselves
			const country = countries.findByCountryCode(user.country.toUpperCase());
			Promise.all([country]).then(([userCountry]) => {
				if (country.statusCode == 200) {
					var region = userCountry.data[0].region;
					Account.findOne({_id: req.params.user_id},
						function(err, data){
							if (err) {
								logger.log('warn', "[Update User] Unable to update user account: " + req.params.user_id, err);
								res.status(500);
								res.send();
							} else {
								if (req.user.username === mqtt_user) {
									logger.log('info', "[Update User] Superuser updated user account: " + req.params.user_id);
								}
								else {
									logger.log('info', "[Update User] Self-service user account update: " + req.params.user_id);
								}
								data.email = user.email;
								data.country = user.country.toUpperCase();
								data.region = region;
								data.save(function(err, d){
									res.status(201);
									res.send(d);
								});
							}
						});
				}
			}).catch(err => {
				logger.log('warn', "[Update User] Unable to update user account, user region lookup failed.");
				res.status(500).send("Unable to update user account, user region lookup failed!");
			});
		}
		else {
			logger.log('warn', "[Update User] Attempt to modify user account blocked");
		}
});

app.delete('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var userId = req.params.user_id;
		const user = Account.findOne({_id: userId});
		Promise.all([user]).then(([userAccount]) => {
			//logger.log('info', "userAccount: " + userAccount);
			//res.render('pages/account',{user: userAccount, acc: true});
			if (userAccount.username == req.user.username || req.user.username === mqtt_user) {
				const deleteAccount = Account.deleteOne({_id: userId});
				const deleteGrantCodes = oauthModels.GrantCode.deleteMany({user: userId});
				const deleteAccessTokens = oauthModels.AccessToken.deleteMany({user: userId});
				const deleteRefreshTokens = oauthModels.RefreshToken.deleteMany({user: userId});
				const deleteDevices = Devices.deleteMany({username: userAccount.username});
				const deleteTopics = Topics.deleteOne({_id:userAccount.topics});
				Promise.all([deleteAccount, deleteGrantCodes, deleteAccessTokens, deleteRefreshTokens, deleteDevices, deleteTopics]).then(result => {
					//logger.log('info', result);
					res.status(202).json({message: 'deleted'});
					if (req.user.username === mqtt_user) {
						logger.log('info', "[Delete User] Superuser deleted user account: " + userId)
					}
					else {
						logger.log('info', "[Delete User] Self-service account deletion, user account: " + userId)
					}
				}).catch(err => {
					logger.log('warn', "[Delete User] Failed to delete user account: " + userId);
					res.status(500).json({error: err});
				});
			}
			else {
				logger.log('warn', "[Delete User] Attempt to delete user account blocked");
			}
		}).catch(err => {
			logger.log('warn', "[Delete User] Failed to find user account: " + userId);
			res.status(500).send();
		});
});

app.post('/device/:dev_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var id = req.params.dev_id;
		var device = req.body;
		if (user === device.username) {
			Devices.findOne({_id: device._id, username: device.username},
				function(err, data){
					if (err) {
						res.status(500);
						res.send(err);
					} else {
						data.description = device.description;
						data.capabilities = device.capabilities;
						data.displayCategories = device.displayCategories;
						data.reportState = device.reportState;
						data.attributes = device.attributes
						data.state = device.state;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
						if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
					}
				});
		}
});

app.delete('/device/:dev_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var id = req.params.dev_id;
		if (req.user.username != mqtt_user) {
			Devices.deleteOne({_id: id, username: user},
				function(err) {
					if (err) {
						logger.log('warn', "[Device] Unable to delete device id: " + id + " for user: " + req.user.username, err);
						res.status(500);
						res.send(err);
					} else {
						logger.log('info', "[Device] Deleted device id: " + id + " for user: " + req.user.username);
						res.status(202);
						res.send();
						if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
					}
				});
		}
		else if (req.user.username === mqtt_user) {
			Devices.deleteOne({_id: id},
				function(err) {
					if (err) {
						logger.log('warn', "[Admin] Unable to delete device id: " + id, err);
						res.status(500);
						res.send(err);
					} else {
						logger.log('info', "[Admin] Superuser deleted device id: " + id);
						res.status(202);
						res.send();
						if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
					}
				});
		}
});

app.post('/api/v1/devices', defaultLimiter,
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		var devices = req.body;
		if (typeof devices == 'object' && Array.isArray(devices)) {
			for (var i=0; i<devices.lenght; i++) {
				var endpointId = devices[i].endpointId;
				Devices.updateOne({
						username: req.user, 
						endpointId: endpointId
					},
					devices[i],
					{
						upsert: true
					},
					function(err){
						//log error
				});
			}
			if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
		} else {
			res.error(400);
		}
	}
);

app.get('/admin/services', defaultLimiter,
	ensureAuthenticated, 
	function(req,res){
		if (req.user.username === mqtt_user) {
			var view = {
				dp: req.path, 
				dh: 'https://' + process.env.WEB_HOSTNAME,
				dt: 'Services Admin',
				uid: req.user.username,
				uip: req.ip,
				ua: req.headers['user-agent']
			}
			if (enableAnalytics) {visitor.pageview(view).send()};
		
			const applications = oauthModels.Application.find({});
			Promise.all([applications]).then(([apps]) => {
					res.render('pages/services',{user:req.user, services: apps});
				}).catch(err => {
					res.status(500).json({error: err});
				});
		} else {
			res.status(401).send();
		}
});

app.get('/admin/users', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			// https://docs.mongodb.com/manual/reference/method/db.collection.find/#explicitly-excluded-fields
			var view = {
				dp: req.path, 
				dh: 'https://' + process.env.WEB_HOSTNAME,
				dt: 'User Admin',
				uid: req.user.username,
				uip: req.ip,
				ua: req.headers['user-agent']
			}
			if (enableAnalytics) {visitor.pageview(view).send()};

			const countUsers = Account.countDocuments({});
			const usersAndCountDevices = Account.aggregate([
				{ "$lookup": {
					"from": "devices",
					"let": { "username": "$username" },
					"pipeline": [
					  { "$match": {
						"$expr": { "$eq": [ "$$username", "$username" ] }
					  }},
					  { "$count": "count" }
					],
					"as": "deviceCount"    
				  }},
				  { "$addFields": {
					"countDevices": { "$sum": "$deviceCount.count" }
				  }}
			 ]);
			Promise.all([countUsers, usersAndCountDevices]).then(([totalCount, usersAndDevs]) => {
				//logger.log('info', "users: " + users)
				//logger.log('info', "totalCount: " + totalCount)
				//logger.log('info', "usersAndDevs: " + JSON.stringify(usersAndDevs));
				res.render('pages/users',{user:req.user, users: usersAndDevs, usercount: totalCount});
			}).catch(err => {
				res.status(500).json({error: err});
			});
		}
		else {
			res.status(401).send();
		}
});

app.get('/admin/user-devices', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			var view = {
				dp: req.path, 
				dh: 'https://' + process.env.WEB_HOSTNAME,
				dt: 'User Device Admin',
				uid: req.user.username,
				uip: req.ip,
				ua: req.headers['user-agent']
			}
			if (enableAnalytics) {visitor.pageview(view).send()};

			const userDevices = Devices.find({});
			const countDevices = Devices.countDocuments({});
			Promise.all([userDevices, countDevices]).then(([devices, count]) => {
				res.render('pages/user-devices',{user:req.user, devices: devices, devicecount: count});
			}).catch(err => {
				res.status(500).json({error: err});
			});
	} else {
			res.status(401).send();
		}
});

// One-time, sync Alexa and Google Home data, this will copy device.validRange to device.attributes element
// app.get('/admin/update-schema', defaultLimiter,
// 	ensureAuthenticated,
// 	function(req,res){
// 		if (req.user.username === mqtt_user) {
// 			const userDevices = Devices.find({});
// 			Promise.all([userDevices]).then(([devices]) => {
// 				//logger.log('info', JSON.stringify(devices));
// 				devices.forEach(dev => {
// 					if (dev) {
// 						dev.validRange = dev.validRange;
// 						dev.attributes = ( dev.attributes || {});
// 						logger.log('info', "endpointId:" + dev.endpointId + ":" + JSON.stringify(dev));
// 						var hasAttributes = false;
// 						if (dev.capabilities.indexOf("ThermostatController") > -1) { // Thermostat
// 							if (dev.validRange.minimumValue > 0 && dev.validRange.maximumValue > 0) {
// 								hasAttributes = true;
// 								dev.attributes.temperatureRange = {};
// 								dev.attributes.temperatureRange.temperatureMin = dev.validRange.minimumValue;
// 								dev.attributes.temperatureRange.temperatureMax = dev.validRange.maximumValue;
// 								dev.attributes.temperatureScale = dev.validRange.scale.toUpperCase();
// 								dev.attributes.thermostatModes = ["HEAT", "COOL", "AUTO"]; // All declared devices currently have this by nature of discovery response
// 							}
// 						}
// 						if (dev.capabilities.indexOf("ColorController") > -1) { // ColorController
// 							if (dev.validRange.minimumValue > 0 &&  dev.validRange.maximumValue > 100) {
// 								hasAttributes = true;
// 								dev.attributes.colorModel = "hsv";
// 								dev.attributes.colorTemperatureRange = {};
// 								dev.attributes.colorTemperatureRange.temperatureMinK = dev.validRange.minimumValue;
// 								dev.attributes.colorTemperatureRange.temperatureMaxK = dev.validRange.maximumValue;
// 							}
// 						}
// 						if (dev.capabilities.indexOf("SceneController") > -1) { // Scene
// 							hasAttributes = true;
// 							dev.attributes.sceneReversible = true;
// 						}
// 						if (dev.capabilities.indexOf("TemperatureSensor") > -1) { // Thermostat
// 							hasAttributes = true;
// 							dev.attributes.temperatureScale = dev.validRange.scale;
// 						}
// 						if (hasAttributes == true) {
// 							logger.log('info', "endpointId: " + dev.endpointId + ", CHANGED, new dev.attributes value: " + JSON.stringify(dev.attributes));
// 							Devices.updateOne({_id:dev._id}, { $set: { attributes: dev.attributes }}, function(err, data) {
// 							 	if (err) {
// 							 		logger.log('warn', "ERROR updating dev.attributes for endpointId: " + dev.endpointId);
// 							 	}
// 							 	else {logger.log('info', "SUCCESS Updated dev.attributes for endpointId: " + dev.endpointId);}
// 							});
// 						} else {
// 							logger.log('info', "endpointId: " + dev.endpointId + ", NO CHANGE");
// 						}
// 					}
// 				});
// 				res.status(200).send();
// 			}).catch(err => {
// 				res.status(500).json({error: err});
// 			});
// 		} else {
// 			res.status(401).send();
// 		}
// });

app.put('/services', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username == mqtt_user) {
			var application = oauthModels.Application(req.body);
			application.save(function(err, application){
				if (!err) {
					res.status(201).send(application);
				}
			});
		} else {
			res.status(401).send();
		}
});

app.post('/service/:id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var service = req.body;
		oauthModels.Application.findOne({_id: req.params.id},
			function(err,data){
				if (err) {
						res.status(500);
						res.send(err);
					} else {
						data.title = service.title;
						data.oauth_secret = service.oauth_secret;
						data.domains = service.domains;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
					}
			});
});

app.delete('/service/:id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		oauthModels.Application.remove({_id:req.params.id},
			function(err){
				if (!err) {
					res.status(200).send();
				} else {
					res.status(500).send();
				}
			});
});

// Create HTTPS Server
//var certKey = "/etc/letsencrypt/live/" + process.env.WEB_HOSTNAME + "/privkey.pem";
//var certChain = "/etc/letsencrypt/live/" + process.env.WEB_HOSTNAME + "/fullchain.pem";
// var options = {
// 	key: fs.readFileSync(certKey),
// 	cert: fs.readFileSync(certChain)
// };
// var server = https.createServer(options, app);

// Create HTTP Server, to be proxied
var server = http.Server(app);

server.listen(port, host, function(){
	logger.log('info', "[Core] App listening on: " + host + ":" + port);
	logger.log('info', "[Core] App_ID -> " + app_id);
	setTimeout(function(){
	},5000);
});

// GHome Request Sync, see: https://developers.google.com/actions/smarthome/request-sync 
function gHomeSync(userid){
	oauthModels.Application.findOne({domains: "oauth-redirect.googleusercontent.com" },function(err, data){
		if (data) {
			// Find User and GrantCode, as DISCONNECT API will delete all Grant Codes for users we can assume if grant code exists user is "active"
			var userAccount = Account.findOne({_id:userid});
			var arrGrantCodes = oauthModels.GrantCode.find({user: userid, application: data._id});
			Promise.all([userAccount, arrGrantCodes]).then(([user, grants]) => {
				if (user && grants.length > 0) {
					request(
						{
							headers: {
								"User-Agent": "request",
								"Referer": "https://" + process.env.WEB_HOSTNAME
							  },
							url: SYNC_API,
							method: "POST",
							json: {
								agentUserId: user._id
							}
						},
						function(err, resp, body) {
							if (!err) {
								logger.log('debug', "[GHome Sync Devices] Success for user:" + user.username + ", userid" + user._id);
							} else {
								logger.log('debug', "[GHome Sync Devices] Failure for user:" + user.username + ", error: " + err);
							}
						}
					);
				}
				else if ( grants.length = 0) {
					logger.log('debug', "[GHome Sync Devices] Not sending Sync Request for user:" + user.username + ", user has not linked Google Account with bridge account");
				}
			}).catch(err => {
				logger.log('error', "[GHome Sync Devices] Error:" + err);
			});
		}
	});
}

// Set State Function, sets device "state" element in MongoDB based upon Node-RED MQTT 'state' message
function setstate(username, endpointId, payload) {
	// Check payload has state property
	logger.log('debug', "[State API] SetState payload:" + JSON.stringify(payload));
	if (payload.hasOwnProperty('state')) {
		// Find existing device, we need to retain state elements, state is fluid/ will contain new elements so flattened input no good
		Devices.findOne({username:username, endpointId:endpointId},function(error,dev){
			if (error) {
				logger.log('warn', "[State API] Unable to find enpointId: " + endpointId + " for username: " + username);
			}
			if (dev) {
				var dt = new Date().toISOString();
				var deviceJSON = JSON.parse(JSON.stringify(dev));
				dev.state = (dev.state || {});
				dev.state.time = dt;
				if (payload.state.hasOwnProperty('brightness')) {dev.state.brightness = payload.state.brightness};
				if (payload.state.hasOwnProperty('channel')) {dev.state.input = payload.state.channel};
				if (payload.state.hasOwnProperty('colorBrightness')) {dev.state.colorBrightness = payload.state.colorBrightness};
				if (payload.state.hasOwnProperty('colorHue')) {dev.state.colorHue = payload.state.colorHue};
				if (payload.state.hasOwnProperty('colorSaturation')) {dev.state.colorSaturation = payload.state.colorSaturation};
				if (payload.state.hasOwnProperty('colorTemperature')) {dev.state.colorTemperature = payload.state.colorTemperature}
				if (payload.state.hasOwnProperty('input')) {dev.state.input = payload.state.input};
				if (payload.state.hasOwnProperty('lock')) {dev.state.lock = payload.state.lock};
				if (payload.state.hasOwnProperty('percentage')) {dev.state.percentage = payload.state.percentage};
				if (payload.state.hasOwnProperty('percentageDelta')) {
					if (dev.state.hasOwnProperty('percentage')) {
						var newPercentage = dev.state.percentage + payload.state.percentageDelta;
						if (newPercentage > 100) {newPercentage = 100}
						else if (newPercentage < 0) {newPercentage = 0}
						dev.state.percentage = newPercentage;
					}
				};
				if (payload.state.hasOwnProperty('playback')) {dev.state.playback = payload.state.playback};
				if (payload.state.hasOwnProperty('power')) {dev.state.power = payload.state.power}
				if (payload.state.hasOwnProperty('targetSetpointDelta')) {
					if (dev.state.hasOwnProperty('thermostatSetPoint')) {
						var newMode;
						var newTemp = dev.state.thermostatSetPoint + payload.state.targetSetpointDelta;
						// Get Supported Ranges and work-out new value for thermostatMode
						if (deviceJSON.attributes.hasOwnProperty('thermostatModes')){
							var countModes = deviceJSON.attributes.thermostatModes.length;
							var arrModes = deviceJSON.attributes.thermostatModes;
							// If single mode is supported leave as-is
							if (countModes == 1){
								newMode = dev.state.thermostatMode;
							}
							else {
								var auto = false;
								var heat = false;
								var cool = false;
								var on = false;
								var off = false;
								if (arrModes.indexOf('AUTO') > -1){auto = true};
								if (arrModes.indexOf('HEAT') > -1){heat = true};
								if (arrModes.indexOf('COOL') > -1){cool = true};
								if (arrModes.indexOf('ON') > -1){on = true};
								if (arrModes.indexOf('OFF') > -1){off = true};
								// Supported combos
									// ON and OFF
									// HEAT and COOL
									// HEAT, COOl, AUTO
									// HEAT, COOl, AUTO, ON, OFF
								if (countModes == 2 && (on && off)) { // On and Off Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "OFF"}
									else {newMode = "ON"}
								}
								else if (countModes == 2 && (heat && cool)) { // Cool and Heat Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 3 && (heat && cool && auto)) { // Heat, Cool and Auto Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 5 && (on && off && on && off && auto)) { // All Modes Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else { // Fallback position
									newMode = "HEAT";
								}
							}
						}
						// Check within supported range of device
						if (deviceJSON.hasOwnProperty('attributes')) {
							if (deviceJSON.attributes.hasOwnProperty('temperatureRange')) {
								if (deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMin') && deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMax')) {
									if (!(newTemp < deviceJSON.attributes.temperatureRange.temperatureMin) || !(newTemp > deviceJSON.attributes.temperatureRange.temperatureMax)) {
										dev.state.thermostatSetPoint = newTemp;
										dev.state.thermostatMode = newMode;
									}
								}

							}
						}
					}
				}
				if (payload.state.hasOwnProperty('temperature')) {dev.state.temperature = payload.state.temperature};
				if (payload.state.hasOwnProperty('thermostatMode') && !payload.state.hasOwnProperty('thermostatSetPoint')) {
					dev.state.thermostatMode = payload.state.thermostatMode;
				};
				if (payload.state.hasOwnProperty('thermostatSetPoint')) {
					if (dev.state.hasOwnProperty('thermostatSetPoint')) {
						var newMode;
						var newTemp = payload.state.thermostatSetPoint;
						// Get Supported Ranges and work-out new value for thermostatMode
						if (deviceJSON.attributes.hasOwnProperty('thermostatModes')){
							var countModes = deviceJSON.attributes.thermostatModes.length;
							var arrModes = deviceJSON.attributes.thermostatModes;
							// If single mode is supported leave as-is
							if (countModes == 1){
								newMode = dev.state.thermostatMode;
							}
							else {
								var auto = false;
								var heat = false;
								var cool = false;
								var on = false;
								var off = false;
								if (arrModes.indexOf('AUTO') > -1){auto = true};
								if (arrModes.indexOf('HEAT') > -1){heat = true};
								if (arrModes.indexOf('COOL') > -1){cool = true};
								if (arrModes.indexOf('ON') > -1){on = true};
								if (arrModes.indexOf('OFF') > -1){off = true};
								logger.log('debug', "[State API] thermostatSetPoint, modes: " + JSON.stringify(deviceJSON.attributes.thermostatModes) + ", countModes: " + countModes);
								// Supported combos
									// ON and OFF
									// HEAT and COOL
									// HEAT, COOl, AUTO
									// HEAT, COOl, AUTO, ON, OFF
								// Set dev.state.thermostatMode
								if (countModes == 2 && (on && off)) { // On and Off Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "OFF"}
									else {newMode = "ON"}
								}
								else if (countModes == 2 && (heat && cool)) { // Cool and Heat Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 3 && (heat && cool && auto)) { // Heat, Cool and Auto Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 5 && (on && off && on && off && auto)) { // All Modes Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else { // Fallback position
									newMode = "HEAT";
								}
								logger.log('debug', "[State API] thermostatSetPoint, newMode: " + newMode);
								logger.log('debug', "[State API] thermostatSetPoint, newTemp: " + newTemp);
							}
						}
						// Check within supported range of device
						if (deviceJSON.hasOwnProperty('attributes')) {
							if (deviceJSON.attributes.hasOwnProperty('temperatureRange')) {
								if (deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMin') && deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMax')) {
									if (!(newTemp < deviceJSON.attributes.temperatureRange.temperatureMin) || !(newTemp > deviceJSON.attributes.temperatureRange.temperatureMax)) {
										dev.state.thermostatSetPoint = newTemp;
										dev.state.thermostatMode = newMode;
									}
								}

							}
						}
					}
				}
				if (payload.state.hasOwnProperty('volume')) {dev.state.volume = payload.state.volume}
				if (payload.state.hasOwnProperty('volumeDelta')) {
					if (dev.state.hasOwnProperty('volume')) {
						var newVolume = dev.state.volume + payload.state.volumeDelta;
						dev.state.volume = newVolume;
					}
				}
				logger.log('debug', "[State API] Endpoint state update: " + JSON.stringify(dev.state));
				// Update state element with modified properties
				Devices.updateOne({username:username, endpointId:endpointId}, { $set: { state: dev.state }}, function(err, data) {
					if (err) {
						logger.log('debug', "[State API] Error updating state for endpointId: " + endpointId);
					}
					else {logger.log('debug', "[State API] Updated state for endpointId: " + endpointId);}
				});
			}
		});
	}
	else {
		logger.log('warn', "[State API] setstate called, but MQTT payload has no 'state' property!");
	}
}

// Nested attribute/ element tester
function getSafe(fn) {
	//logger.log('debug', "[getSafe] Checking element exists:" + fn)
	try {
		return fn();
    } catch (e) {
		//logger.log('debug', "[getSafe] Element not found:" + fn)
        return undefined;
    }
}
