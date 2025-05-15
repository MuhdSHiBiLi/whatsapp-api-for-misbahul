
const express = require('express');
const qrcode = require('qrcode');
const { Client, MessageMedia, Buttons } = require('whatsapp-web.js');
const fs = require('fs');

const app = express();

// Middleware to allow JSON body
// app.use(express.json());
app.use(express.json({ limit: '10mb' })); // Increase JSON payload limit
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Set up logging with timestamps
function log(message) {
  const now = new Date();
  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12; // Convert to 12-hour format
  const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${hours}:${minutes}:${seconds} ${ampm}`;
  console.log(`[${timestamp}] ${message}`);
}

// Global variables
let qrCodeData = '';
let isLoggedIn = false;
let loggedInNumber = '';
let loggedInName = ''; // Store user's name
let profilePictureUrl = ''; // Store profile picture as base64
let connectionState = 'INITIALIZING';
let client = null;
let isClientDestroying = false;
let reconnectionTimer = null;
let monitoringTimer = null;
let connectionCheckTimer = null;
let lastConnectionAttempt = 0;
let reconnectionAttempts = 0;
let lastKnownState = null;
let lastActiveTimestamp = 0;
let qrGenerationTime = 0; // Track when QR was generated
let qrAttempts = 0; // Track QR generation attempts
let qrAutoRefresh = false; // Flag to control QR auto refresh
const MAX_RECONNECTION_ATTEMPTS = 3;
const MIN_RECONNECT_INTERVAL = 30000; // 30 seconds between reconnection attempts
const CONNECTION_CHECK_INTERVAL = 15000; // Check connection every 15 seconds
const QR_MAX_AGE = 300000; // QR code max age in ms (5 minutes)
const PAGE_REFRESH_INTERVAL = 20000; // Page refresh every 20 seconds (between 15-25 sec)

// Function to safely destroy client
async function destroyClient() {
  if (client && !isClientDestroying) {
    isClientDestroying = true;
    try {
      log('🛑 Destroying existing WhatsApp client...');
      await client.destroy();
      log('✅ Client destroyed successfully');
    } catch (error) {
      log(`❌ Error destroying client: ${error.message}`);
    } finally {
      client = null;
      isClientDestroying = false;
      isLoggedIn = false;
      connectionState = 'DISCONNECTED';
      profilePictureUrl = '';
      loggedInName = '';
    }
  }
}

// Active check for connection state
async function checkActiveConnection() {
  if (!client || !isLoggedIn) return;

  try {
    // Try to get state as a live check
    const state = await client.getState();
    lastKnownState = state;
    lastActiveTimestamp = Date.now();
    
    log(`🔍 Active connection check: ${state}`);
    
    if (state === 'CONNECTED') {
      // All good, connection is active
      connectionState = 'CONNECTED';
    } else if (state === 'DISCONNECTED') {
      log('⚠️ Active check detected disconnection');
      handleDisconnection('Connection check detected disconnected state');
    } else {
      // Handle other states like CONNECTING
      connectionState = state;
    }
  } catch (error) {
    log(`❌ Active connection check failed: ${error.message}`);
    
    // If we can't get state, the connection might be broken
    if (Date.now() - lastActiveTimestamp > 30000) { // If no successful check in last 30 seconds
      log('⚠️ Connection appears to be broken after failed state checks');
      handleDisconnection('Failed connection checks');
    }
  }
}

// Centralized function to handle disconnection
async function handleDisconnection(reason) {
  log(`🔌 Handling disconnection: ${reason}`);
  connectionState = 'DISCONNECTED';
  isLoggedIn = false;
  loggedInNumber = '';
  loggedInName = '';
  profilePictureUrl = '';
  
  // Stop active connection checking
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }
  
  // Schedule reconnection attempt if not already scheduled
  if (!reconnectionTimer) {
    reconnectionTimer = setTimeout(async () => {
      reconnectionTimer = null;
      reconnectionAttempts++;
      
      if (reconnectionAttempts > MAX_RECONNECTION_ATTEMPTS) {
        log('⚠️ Maximum reconnection attempts reached. Resetting session...');
        reconnectionAttempts = 0;
      }
      
      // Try to reconnect
      initializeWhatsAppClient();
    }, 5000);
  }
}

// Get profile picture and name when connected
async function fetchProfileInfo() {
  if (!client || !isLoggedIn) return;
  
  try {
    // Get user's contact info
    const me = await client.getContactById(client.info.wid._serialized);
    loggedInName = me.name || me.pushname || 'WhatsApp User';
    log(`📝 User name: ${loggedInName}`);
    
    // Get profile picture
    try {
      const profilePic = await client.getProfilePicUrl(client.info.wid._serialized);
      profilePictureUrl = profilePic || '';
      log(`🖼️ Profile picture ${profilePictureUrl ? 'fetched' : 'not available'}`);
    } catch (picError) {
      log(`⚠️ Could not fetch profile picture: ${picError.message}`);
      profilePictureUrl = '';
    }
  } catch (error) {
    log(`❌ Error fetching profile info: ${error.message}`);
    loggedInName = 'WhatsApp User';
    profilePictureUrl = '';
  }
}

// Function to initialize WhatsApp client
async function initializeWhatsAppClient() {
  // Prevent multiple initialization attempts
  if (client || isClientDestroying) {
    log('⚠️ Client initialization already in progress...');
    return;
  }

  // Minimum time between attempts
  const now = Date.now();
  if (now - lastConnectionAttempt < MIN_RECONNECT_INTERVAL) {
    const waitTime = MIN_RECONNECT_INTERVAL - (now - lastConnectionAttempt);
    log(`⏳ Too many connection attempts. Waiting ${waitTime/1000} seconds...`);
    return;
  }
  lastConnectionAttempt = now;

  log('🔄 Initializing WhatsApp client...');
  connectionState = 'INITIALIZING';
  isLoggedIn = false;
  qrCodeData = '';
  qrAttempts = 0;

  // Create a fresh client instance with puppeteer-less mode for fly.io
  client = new Client({
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  // Set up event handlers
  client.on('qr', async (qr) => {
    qrAttempts++;
    log(`📱 QR Code received (attempt ${qrAttempts})`);
    
    // Only update QR if it's not undefined and not too frequent
    if (qr && qr.trim() !== 'undefined') {
      try {
        qrCodeData = await qrcode.toDataURL(qr);
        qrGenerationTime = Date.now();
        connectionState = 'QR_READY';
      } catch (error) {
        log(`❌ Error generating QR code: ${error.message}`);
        qrCodeData = '';
        connectionState = 'QR_ERROR';
      }
    } else {
      log('⚠️ Received invalid QR code data, not updating');
    }
    
    // If we receive too many QR codes, something might be wrong
    if (qrAttempts > 5) {
      log('⚠️ Too many QR code attempts, restarting client');
      await destroyClient();
      
      // Wait a bit before trying again
      setTimeout(() => {
        initializeWhatsAppClient();
      }, 3000);
    }
  });

  client.on('authenticated', () => {
    log('🔐 Authentication successful!');
    connectionState = 'AUTHENTICATED';
    qrCodeData = '';
    qrAttempts = 0;
  });

  client.on('auth_failure', async (error) => {
    log(`❌ Authentication failed: ${error}`);
    await handleDisconnection('Authentication failure');
    
    // Try to reinitialize after a delay
    setTimeout(() => {
      initializeWhatsAppClient();
    }, 5000);
  });

  client.on('ready', async () => {
    log('✅ Client is ready!');
    isLoggedIn = true;
    connectionState = 'CONNECTED';
    reconnectionAttempts = 0;
    lastActiveTimestamp = Date.now();
    qrAttempts = 0;
    
    try {
      loggedInNumber = client.info.wid.user;
      log(`📱 Connected with number: +${loggedInNumber}`);
      
      // Fetch profile info
      await fetchProfileInfo();
      
      // Start active connection checking
      if (connectionCheckTimer) clearInterval(connectionCheckTimer);
      connectionCheckTimer = setInterval(checkActiveConnection, CONNECTION_CHECK_INTERVAL);
    } catch (error) {
      log(`⚠️ Could not get connected number: ${error.message}`);
    }
  });

  // client.on('message', async message => {
  //   const text = message.body.toLowerCase();

  //   // Match message using regex or keyword
  //   if (text.includes('i want to join') || /register|sign up/.test(text)) {
  //       const buttons = new Buttons(
  //           'Welcome! Choose one to continue:',
  //           [
  //               { body: 'Join Now' },
  //               { body: 'More Info' },
  //               { body: 'Contact Admin' }
  //           ],
  //           'SSF Registration',
  //           'Tap a button below'
  //       );

  //       await client.sendMessage(message.from, buttons);
  //   }

//     client.on('message', message => {
//     const text = message.body.toLowerCase(); // case-insensitive match

//     if (text.includes('i want')) {
//         message.reply('Thanks for your interest! Please click the link to join: https://yourdomain.com/join');
//     }

//     // You can add more keyword replies here
// });

    // Optional: Handle button replies
//     if (text === 'join now') {
//         await message.reply('Here’s your join link: https://yourdomain.com/join');
//     } else if (text === 'more info') {
//         await message.reply('Visit https://yourdomain.com/info to know more.');
//     } else if (text === 'contact admin') {
//         await message.reply('Contact us at +91XXXXXXXXXX.');
//     }
// });


  client.on('disconnected', async (reason) => {
    log(`❌ Client disconnected event: ${reason}`);
    await handleDisconnection(`Client disconnected: ${reason}`);
  });

  // Additional event to detect when WhatsApp Web is logged out
  client.on('change_state', (state) => {
    log(`🔄 Connection state changed to: ${state}`);
    lastKnownState = state;
    
    if (state === 'DISCONNECTED') {
      handleDisconnection('State changed to DISCONNECTED');
    }
  });
  
  // Handle when device is unpaired (important for detecting manual unlinking)
  client.on('change_battery', (batteryInfo) => {
    log(`🔋 Battery state updated: ${JSON.stringify(batteryInfo)}`);
    // This event confirms connection is still alive
    lastActiveTimestamp = Date.now();
  });

  // Try to initialize
  try {
    log('🚀 Starting WhatsApp client...');
    await client.initialize();
  } catch (error) {
    log(`❌ Client initialization failed: ${error.message}`);
    await handleDisconnection(`Initialization failed: ${error.message}`);
    
    if (!reconnectionTimer) {
      reconnectionTimer = setTimeout(async () => {
        reconnectionTimer = null;
        initializeWhatsAppClient();
      }, 5000);
    }
  }
}

// Start periodic monitoring of connection status
function startMonitoring() {
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
  }
  
  monitoringTimer = setInterval(async () => {
    // Check if QR code is too old and user has requested auto-refresh
    if (qrCodeData && !isLoggedIn && qrAutoRefresh && (Date.now() - qrGenerationTime > QR_MAX_AGE)) {
      log('⚠️ QR code expired and auto-refresh enabled, requesting new one');
      qrCodeData = '';
      connectionState = 'QR_EXPIRED';
      
      // Force client refresh to get a new QR
      await destroyClient();
      setTimeout(() => {
        initializeWhatsAppClient();
      }, 2000);
      return;
    }
    
    if (isLoggedIn) {
      // Check if the session is actually still valid
      try {
        if (client) {
          const state = await client.getState();
          log(`📱 Connection status: ${state} for +${loggedInNumber}`);
          lastKnownState = state;
          lastActiveTimestamp = Date.now();
          
          if (state !== 'CONNECTED') {
            log(`⚠️ State not CONNECTED but ${state}, checking connection...`);
            // Don't immediately disconnect - give it a chance to recover
          }
        } else {
          log('⚠️ Client is null but isLoggedIn is true - fixing state');
          isLoggedIn = false;
          connectionState = 'DISCONNECTED';
        }
      } catch (error) {
        log(`❌ Error checking connection: ${error.message}`);
        
        // If we haven't had a successful check in a while, consider connection lost
        if (Date.now() - lastActiveTimestamp > 30000) { // 30 seconds
          log('⚠️ Connection appears to be lost, triggering reconnection');
          await handleDisconnection('Failed state check in monitoring');
        }
      }
    } else {
      log(`🔄 Connection status check: ${connectionState}`);
      
      // If client doesn't exist and we're not in the middle of connecting
      if (!client && !isClientDestroying && !reconnectionTimer) {
        log('📂 Not connected. Attempting to connect...');
        
        reconnectionAttempts++;
        log(`🔄 Reconnection attempt ${reconnectionAttempts} of ${MAX_RECONNECTION_ATTEMPTS}`);
        
        if (reconnectionAttempts > MAX_RECONNECTION_ATTEMPTS) {
          log('⚠️ Too many reconnection failures. Resetting...');
          reconnectionAttempts = 0;
        }
        
        // Try to initialize again
        initializeWhatsAppClient();
      }
    }
  }, 60000); // Check every minute
}

// Ping test route to test connection
app.get('/ping', async (req, res) => {
  if (!isLoggedIn || !client) {
    return res.status(200).json({
      success: false,
      status: connectionState,
      message: 'WhatsApp not connected'
    });
  }

  try {
    const state = await client.getState();
    lastKnownState = state;
    lastActiveTimestamp = Date.now();
    
    return res.status(200).json({
      success: true,
      status: state,
      number: loggedInNumber,
      name: loggedInName,
      message: 'Connection active'
    });
  } catch (error) {
    log(`❌ Ping check failed: ${error.message}`);
    
    return res.status(200).json({
      success: false,
      status: 'ERROR',
      message: `Failed to check state: ${error.message}`
    });
  }
});

// Generate new QR code manually
app.post('/generate-qr', async (req, res) => {
  log('🔄 Manual QR code generation requested...');
  
  // Only allow this if we're not logged in
  if (isLoggedIn) {
    return res.status(200).json({
      success: false,
      message: 'Cannot generate QR code while logged in'
    });
  }
  
  // Reset client and generate new QR
  await destroyClient();
  qrCodeData = '';
  connectionState = 'GENERATING_QR';
  
  // Initialize new client to get a fresh QR
  setTimeout(() => {
    initializeWhatsAppClient();
  }, 2000);
  
  res.status(200).json({
    success: true,
    message: 'Generating new QR code'
  });
});

// Toggle QR auto-refresh
app.post('/toggle-qr-auto-refresh', (req, res) => {
  qrAutoRefresh = !qrAutoRefresh;
  log(`🔄 QR auto-refresh ${qrAutoRefresh ? 'enabled' : 'disabled'}`);
  
  res.status(200).json({
    success: true,
    autoRefresh: qrAutoRefresh,
    message: `QR auto-refresh ${qrAutoRefresh ? 'enabled' : 'disabled'}`
  });
});

// Web server routes
app.get('/', (req, res) => {
  if (isLoggedIn) {
    res.send(`
      <html>
        <head>
          <title>WhatsApp Status</title>
          <meta http-equiv="refresh" content="${Math.floor(PAGE_REFRESH_INTERVAL/1000)}">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; flex-direction: column; background-color: #f0f2f5; margin: 0; padding: 0; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; width: 100%; }
            .success { color: #128C7E; }
            .refresh { color: #777; font-size: 12px; margin-top: 20px; }
            .actions { margin-top: 20px; }
            .btn { background: #128C7E; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; margin: 0 5px; }
            .btn-danger { background: #e74c3c; }
            .btn-warning { background: #f39c12; }
            .profile-section { display: flex; flex-direction: column; align-items: center; margin-bottom: 20px; }
            .profile-pic { width: 135px; height: 135px; border-radius: 50%; object-fit: cover; border: 3px solid #128C7E; margin-bottom: 10px; }
            .profile-pic-placeholder { width: 100px; height: 100px; border-radius: 50%; background-color: #128C7E; display: flex; align-items: center; justify-content: center; color: white; font-size: 40px; margin-bottom: 10px; }
            .user-name { font-weight: bold; font-size: 18px; margin-bottom: 5px; }
            .user-number { color: #666; margin-bottom: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2 class="success">✅ WhatsApp Connected</h2>
            
            <div class="profile-section">
              ${profilePictureUrl 
                ? `<img src="${profilePictureUrl}" alt="Profile Picture" class="profile-pic" onerror="this.onerror=null;this.src='';this.classList.add('profile-pic-placeholder');this.innerHTML='+';"/>` 
                : `<div class="profile-pic-placeholder">${loggedInName ? loggedInName[0].toUpperCase() : '+'}</div>`
              }
              <div class="user-name">${loggedInName || 'WhatsApp User'}</div>
              <div class="user-number">+${loggedInNumber}</div>
            </div>
            
            <p>WhatsApp session is active and being monitored.</p>
            <p>Current status: ${connectionState}</p>
            <p>Last check: ${new Date().toLocaleTimeString()}</p>
            
            <div class="actions">
              <button class="btn" onclick="pingConnection()">Check Connection</button>
              <button class="btn btn-warning" onclick="logoutConnection()">Logout Device</button>
              <button class="btn btn-danger" onclick="resetConnection()">Reset Connection</button>
            </div>
            <p class="refresh">Page refreshes automatically every ${Math.floor(PAGE_REFRESH_INTERVAL/1000)} seconds.</p>
            <div id="ping-result" style="margin-top: 15px;"></div>
          </div>
          
          <script>
            function pingConnection() {
              document.getElementById('ping-result').innerHTML = 'Checking connection...';
              fetch('/ping')
                .then(response => response.json())
                .then(data => {
                  document.getElementById('ping-result').innerHTML = 
                    data.success ? 
                    '<span style="color:#128C7E">✅ Connection active: ' + data.status + '</span>' : 
                    '<span style="color:#e74c3c">❌ Connection issue: ' + data.message + '</span>';
                })
                .catch(err => {
                  document.getElementById('ping-result').innerHTML = 
                    '<span style="color:#e74c3c">❌ Error checking connection</span>';
                });
            }
            
            function resetConnection() {
              if (confirm('Are you sure you want to reset the WhatsApp connection?')) {
                fetch('/reset', { method: 'POST' })
                  .then(response => response.text())
                  .then(data => {
                    alert(data);
                    setTimeout(() => location.reload(), 1000);
                  })
                  .catch(err => {
                    alert('Error resetting connection');
                  });
              }
            }
            
            function logoutConnection() {
              if (confirm('Are you sure you want to logout this device from WhatsApp?')) {
                fetch('/logout', { method: 'POST' })
                  .then(response => response.text())
                  .then(data => {
                    alert(data);
                    setTimeout(() => location.reload(), 1000);
                  })
                  .catch(err => {
                    alert('Error logging out');
                  });
              }
            }
          </script>
        </body>
      </html>
    `);
  } else if (qrCodeData) {
    // QR code display with manual refresh and auto-refresh toggle
    res.send(`
      <html>
        <head>
          <title>Scan QR Code</title>
          <meta http-equiv="refresh" content="${Math.floor(PAGE_REFRESH_INTERVAL/1000)}">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; flex-direction: column; background-color: #f0f2f5; margin: 0; padding: 0; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; width: 100%; }
            img { max-width: 300px; border: 1px solid #ddd; padding: 10px; margin: 20px 0; }
            .refresh { color: #777; font-size: 12px; margin-top: 20px; }
            .qr-timestamp { font-size: 12px; color: #666; margin-top: 5px; }
            .qr-container { display: flex; justify-content: center; align-items: center; }
            .btn { background: #128C7E; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; margin: 10px 5px; }
            .btn-secondary { background: #888; }
            .toggle-btn { background: ${qrAutoRefresh ? '#f39c12' : '#128C7E'}; }
            .actions { margin-top: 15px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Scan QR Code with WhatsApp</h2>
            <p>Open WhatsApp on your phone, go to Settings > Linked Devices > Link a Device</p>
            <div class="qr-container">
              <img src="${qrCodeData}" alt="WhatsApp QR Code" />
            </div>
            <p class="qr-timestamp">QR Code generated: ${new Date(qrGenerationTime).toLocaleTimeString()}</p>
            <p>Current status: ${connectionState}</p>
            
            <div class="actions">
              <button class="btn" onclick="generateNewQR()">Generate New QR Code</button>
              <button class="btn toggle-btn" onclick="toggleAutoRefresh()">${qrAutoRefresh ? 'Disable' : 'Enable'} Auto-Refresh</button>
            </div>
            
            <p class="refresh">Page refreshes automatically every ${Math.floor(PAGE_REFRESH_INTERVAL/1000)} seconds.</p>
          </div>
          
          <script>
            function generateNewQR() {
              fetch('/generate-qr', { method: 'POST' })
                .then(response => response.json())
                .then(data => {
                  if (data.success) {
                    alert('Generating new QR code...');
                    setTimeout(() => location.reload(), 3000);
                  } else {
                    alert(data.message);
                  }
                })
                .catch(err => {
                  alert('Error generating QR code');
                });
            }
            
            function toggleAutoRefresh() {
              fetch('/toggle-qr-auto-refresh', { method: 'POST' })
                .then(response => response.json())
                .then(data => {
                  alert(data.message);
                  location.reload();
                })
                .catch(err => {
                  alert('Error toggling auto-refresh');
                });
            }
          </script>
        </body>
      </html>
    `);
  } else {
    // Loading state with improved UI
    res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="${Math.floor(PAGE_REFRESH_INTERVAL/1000)}">
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; flex-direction: column; background-color: #f0f2f5; margin: 0; padding: 0; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; width: 100%; }
            .waiting { color: #E37400; }
            .refresh { color: #777; font-size: 12px; margin-top: 20px; }
            .loader { border: 5px solid #f3f3f3; border-radius: 50%; border-top: 5px solid #128C7E; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="container">
            <h2 class="waiting">⏳ Preparing WhatsApp Connection...</h2>
            <div class="loader"></div>
            <p>Current status: ${connectionState}</p>
            <p class="refresh">Page refreshes automatically every ${Math.floor(PAGE_REFRESH_INTERVAL/1000)} seconds.</p>
          </div>
        </body>
      </html>
    `);
  }
});

// Bulk messaging API endpoint
// app.post('/api/send-bulk', async (req, res) => {
//     // Check if WhatsApp is connected
//     if (!isLoggedIn || !client) {
//       return res.status(403).json({
//         success: false,
//         message: 'WhatsApp not connected. Please scan QR code first.'
//       });
//     }
  
//     try {
//       // Get the messages array from request body
//       const { messages } = req.body;
      
//       if (!messages || !Array.isArray(messages) || messages.length === 0) {
//         return res.status(400).json({
//           success: false,
//           message: 'Invalid request. Please provide an array of messages.'
//         });
//       }
      
//       // Start processing messages
//       log(`📤 Starting bulk message sending - ${messages.length} messages queued`);
      
//       // Initial response to prevent timeout
//       res.status(202).json({
//         success: true,
//         message: `Processing ${messages.length} messages in the background`,
//         queued: messages.length
//       });
      
//       // Process messages in the background with a small delay between each
//       let successCount = 0;
//       let failCount = 0;
      
//       // Function to send a single text message
//       const sendTextMessage = async (recipient, message) => {
//         try {
//           // Send simple text message
//           await client.sendMessage(recipient, message);
          
//           // Track successful message
//           successCount++;
//           log(`✅ Sent message to ${recipient}`);
          
//           return { recipient, status: 'success' };
//         } catch (error) {
//           failCount++;
//           log(`❌ Failed to send message to ${recipient}: ${error.message}`);
//           return { recipient, status: 'failed', error: error.message };
//         }
//       };
  
//       // Process each message with a small delay between sends
//       for (let i = 0; i < messages.length; i++) {
//         const { number, message } = messages[i];
        
//         // Validate the number format
//         const formattedNumber = number.startsWith('+') ? 
//           number.substring(1) + '@c.us' : 
//           number + '@c.us';
        
//         try {
//           // Send the text message
//           await sendTextMessage(formattedNumber, message);
          
//           // Small delay between messages to prevent rate limiting (500-800ms)
//           if (i < messages.length - 1) {
//             await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 300) + 500));
//           }
          
//           // Log progress periodically
//           if (i % 10 === 0 || i === messages.length - 1) {
//             log(`📊 Bulk sending progress: ${i + 1}/${messages.length}`);
//           }
//         } catch (error) {
//           log(`❌ Error in bulk send loop: ${error.message}`);
//           failCount++;
//         }
//       }
      
//       // Log final results
//       log(`✅ Bulk message sending completed: ${successCount} successful, ${failCount} failed`);
      
//     } catch (error) {
//       log(`❌ Error in bulk sending API: ${error.message}`);
//       // We've already sent the initial response
//     }
//   });

  
//   app.post('/api/send-bulk-qr', async (req, res) => {
//     // Check if WhatsApp is connected
//     if (!isLoggedIn || !client) {
//       return res.status(403).json({
//         success: false,
//         message: 'WhatsApp not connected. Please scan QR code first.'
//       });
//     }
    
//     try {
//       // Get the messages array from request body
//       const { messages } = req.body;
      
//       if (!messages || !Array.isArray(messages) || messages.length === 0) {
//         return res.status(400).json({
//           success: false,
//           message: 'Invalid request. Please provide an array of messages.'
//         });
//       }
      
//       // Start processing messages
//       log(`📤 Starting bulk message sending - ${messages.length} messages queued`);
      
//       // Initial response to prevent timeout
//       res.status(202).json({
//         success: true,
//         message: `Processing ${messages.length} messages in the background`,
//         queued: messages.length
//       });
      
//       // Process messages in the background with a small delay between each
//       let successCount = 0;
//       let failCount = 0;
      
//       // Function to generate QR code from data
//       const generateQRCode = async (qrData) => {
//         try {
//           if (!qrData) return null;
          
//           // Generate QR code as data URL using qrcode library
//           // Using await directly with the promise-based API
//           const qrCodeDataURL = await qrcode.toDataURL(qrData, {
//             errorCorrectionLevel: 'H',
//             margin: 1,
//             width: 300
//           });
          
//           // Convert data URL to buffer
//           const base64Data = qrCodeDataURL.replace(/^data:image\/png;base64,/, '');
//           const imageBuffer = Buffer.from(base64Data, 'base64');
          
//           return imageBuffer;
//         } catch (error) {
//           log(`❌ Error generating QR code: ${error.message}`);
//           return null;
//         }
//       };
      
//       // Function to send a message - either text or image with caption
//       const sendMessage = async (recipient, message, qrData) => {
//         try {
//           // Format the number
//           const formattedNumber = recipient.startsWith('+') ?
//             recipient.substring(1) + '@c.us' :
//             recipient + '@c.us';
          
//           // If QR data is provided, send image with caption
//           if (qrData) {
//             try {
//               // Generate QR code image
//               const qrImageBuffer = await generateQRCode(qrData);
              
//               if (qrImageBuffer) {
//                 // Create media from buffer
//                 const media = new MessageMedia('image/png', qrImageBuffer.toString('base64'), 'qrcode.png');
                
//                 // Send the image with message as caption
//                 await client.sendMessage(formattedNumber, media, { caption: message });
                
//                 successCount++;
//                 log(`✅ Sent QR image message to ${recipient}`);
//               } else {
//                 // If QR generation failed, send text message only
//                 await client.sendMessage(formattedNumber, message);
//                 log(`⚠️ QR generation failed for ${recipient}, sent text only`);
//                 successCount++;
//               }
//             } catch (qrError) {
//               // If there's an error with QR generation, fall back to text message
//               log(`⚠️ QR error for ${recipient}: ${qrError.message}, sending text only`);
//               await client.sendMessage(formattedNumber, message);
//               successCount++;
//             }
//           } else {
//             // Send simple text message
//             await client.sendMessage(formattedNumber, message);
//             successCount++;
//             log(`✅ Sent text message to ${recipient}`);
//           }
          
//           return { recipient, status: 'success' };
//         } catch (error) {
//           failCount++;
//           log(`❌ Failed to send message to ${recipient}: ${error.message}`);
//           return { recipient, status: 'failed', error: error.message };
//         }
//       };
      
//       // Process each message with a small delay between sends
//       for (let i = 0; i < messages.length; i++) {
//         const { number, message, qrData } = messages[i];
        
//         try {
//           // Send the message (with QR if available)
//           await sendMessage(number, message, qrData);
          
//           // Small delay between messages to prevent rate limiting (500-800ms)
//           if (i < messages.length - 1) {
//             await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 300) + 500));
//           }
          
//           // Log progress periodically
//           if (i % 10 === 0 || i === messages.length - 1) {
//             log(`📊 Bulk sending progress: ${i + 1}/${messages.length}`);
//           }
//         } catch (error) {
//           log(`❌ Error in bulk send loop: ${error.message}`);
//           failCount++;
//         }
//       }
      
//       // Log final results
//       log(`✅ Bulk message sending completed: ${successCount} successful, ${failCount} failed`);
      
//     } catch (error) {
//       log(`❌ Error in bulk sending API: ${error.message}`);
//       // We've already sent the initial response
//     }
//   });

// app.post('/api/send-messages', async (req, res) => {
//   // Check if WhatsApp is connected
//   if (!isLoggedIn || !client) {
//     return res.status(403).json({
//       success: false,
//       message: 'WhatsApp not connected. Please scan QR code first.'
//     });
//   }

//   try {
//     // Get the messages array from request body
//     const { messages } = req.body;
    
//     if (!messages || !Array.isArray(messages) || messages.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid request. Please provide an array of messages.'
//       });
//     }
    
//     // Immediately respond to prevent timeout
//     res.status(202).json({
//       success: true,
//       message: `Processing ${messages.length} messages in the background`,
//       queued: messages.length
//     });
    
//     // Track success and failure
//     let successCount = 0;
//     let failCount = 0;
    
//     // Process messages one by one
//     for (let i = 0; i < messages.length; i++) {
//       const { number, message, qrData } = messages[i];
      
//       // Format phone number
//       const formattedNumber = number.startsWith('+') ?
//         number.substring(1) + '@c.us' :
//         number + '@c.us';
      
//       try {
//         // Check if this message should include a QR code
//         if (qrData) {
//           try {
//             // Generate QR code
//             const qrImageBuffer = await generateQRCode(qrData);
            
//             if (qrImageBuffer) {
//               // Create media from buffer
//               const media = new MessageMedia('image/png', qrImageBuffer.toString('base64'), 'qrcode.png');
              
//               // Send the image with message as caption
//               await client.sendMessage(formattedNumber, media, { caption: message });
              
//               successCount++;
//               log(`✅ Sent QR image message to ${number} (${i+1}/${messages.length})`);
//             } else {
//               // QR generation failed, send text only
//               await client.sendMessage(formattedNumber, message);
//               successCount++;
//               log(`⚠️ QR generation failed for ${number}, sent text only (${i+1}/${messages.length})`);
//             }
//           } catch (qrError) {
//             // If QR generation errors, fall back to text message
//             log(`⚠️ QR error for ${number}: ${qrError.message}, sending text only`);
//             await client.sendMessage(formattedNumber, message);
//             successCount++;
//           }
//         } else {
//           // Send simple text message (no QR)
//           await client.sendMessage(formattedNumber, message);
//           successCount++;
//           log(`✅ Sent text message to ${number} (${i+1}/${messages.length})`);
//         }
//       } catch (error) {
//         failCount++;
//         log(`❌ Failed to send message to ${number}: ${error.message} (${i+1}/${messages.length})`);
//       }
      
//       // Add delay between messages (600-900ms)
//       if (i < messages.length - 1) {
//         await new Promise(resolve => setTimeout(resolve, 600 + Math.floor(Math.random() * 300)));
//       }
      
//       // Log progress periodically
//       if (i % 5 === 0 || i === messages.length - 1) {
//         log(`📊 Sending progress: ${i + 1}/${messages.length} (${successCount} success, ${failCount} fail)`);
//       }
//     }
    
//     // Log final results
//     log(`✅ Message sending completed: ${successCount} successful, ${failCount} failed`);
    
//   } catch (error) {
//     log(`❌ Error in message sending API: ${error.message}`);
//   }
// });

// // Improved QR code generation function with better error handling
// const generateQRCode = async (qrData) => {
//   if (!qrData) return null;
  
//   try {
//     // Set a timeout for QR generation to prevent hanging
//     const qrPromise = new Promise((resolve, reject) => {
//       qrcode.toBuffer(qrData, {
//         errorCorrectionLevel: 'M',
//         margin: 1,
//         width: 300,
//         color: {
//           dark: '#000000',
//           light: '#ffffff'
//         }
//       })
//       .then(resolve)
//       .catch(reject);
      
//       // Set 5 second timeout for QR generation
//       setTimeout(() => reject(new Error('QR generation timeout')), 5000);
//     });
    
//     return await qrPromise;
//   } catch (error) {
//     log(`❌ Error generating QR code: ${error.message}`);
//     return null;
//   }
// };
// // Status endpoint to check server and WhatsApp connection status
// app.get('/status', async (req, res) => {
//   let state = connectionState;

//   // If logged in, try to get real-time state
//   if (isLoggedIn && client) {
//     try {
//       state = await client.getState();
//       lastKnownState = state;
//       lastActiveTimestamp = Date.now();
//     } catch (error) {
//       log(`❌ Error getting state for status endpoint: ${error.message}`);
//       // Keep using the stored connectionState if error
//     }
//   }

//   res.json({
//     server: 'running',
//     whatsapp: {
//       connected: isLoggedIn,
//       state: state,
//       number: isLoggedIn ? loggedInNumber : null,
//       name: isLoggedIn ? loggedInName : null,
//       profilePicture: isLoggedIn ? (profilePictureUrl ? true : false) : false,
//       lastActive: lastActiveTimestamp > 0 ? new Date(lastActiveTimestamp).toISOString() : null,
//       qrAutoRefresh: qrAutoRefresh
//     }
//   });
// });

// const generateQRCode = async (qrData) => {
//   if (!qrData) return null;

//   try {
//     const qrPromise = new Promise((resolve, reject) => {
//       qrcode.toBuffer(qrData, {
//         errorCorrectionLevel: 'M',
//         margin: 1,
//         width: 300,
//         color: {
//           dark: '#000000',
//           light: '#ffffff'
//         }
//       })
//       .then(resolve)
//       .catch(reject);

//       setTimeout(() => reject(new Error('QR generation timeout')), 5000);
//     });

//     return await qrPromise;
//   } catch (error) {
//     log(`❌ Error generating QR code: ${error.message}`);
//     return null;
//   }
// };

// Improved version of the QR code generator function
const generateQRCode = async (qrData) => {
  if (!qrData) return null;
  try {
    // Implement timeout protection for QR generation
    const qrPromise = new Promise((resolve, reject) => {
      qrcode.toBuffer(qrData, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 350,  // Slightly larger for better scannability
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      })
      .then(resolve)
      .catch(reject);
      
      // Timeout after 8 seconds (increased from 5)
      setTimeout(() => reject(new Error('QR generation timeout')), 8000);
    });
    
    return await qrPromise;
  } catch (error) {
    log(`❌ Error generating QR code: ${error.message}`);
    return null;
  }
};

// Endpoint for sending bulk messages with batching
app.post('/api/send-messages', async (req, res) => {
  // Check if WhatsApp is connected
  if (!isLoggedIn || !client) {
    return res.status(403).json({
      success: false,
      message: 'WhatsApp not connected. Please scan QR code first.'
    });
  }

  try {
    // Get the messages array from request body
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request. Please provide an array of messages.'
      });
    }

    // Immediately respond to prevent timeout
    res.status(202).json({
      success: true,
      message: `Processing ${messages.length} messages in batches`,
      queued: messages.length
    });

    // Implementation of batching mechanism
    const BATCH_SIZE = 20; // Number of messages per batch
    const BATCH_DELAY = 3000; // Delay between batches in ms (3 seconds)
    const MESSAGE_DELAY = 1000; // Delay between messages in ms (1 second)
    
    // Track success and failure
    let successCount = 0;
    let failCount = 0;
    
    // Process messages in batches
    for (let batchStart = 0; batchStart < messages.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, messages.length);
      log(`📦 Processing batch ${Math.floor(batchStart/BATCH_SIZE) + 1}: messages ${batchStart+1} to ${batchEnd}`);
      
      // Process current batch
      for (let i = batchStart; i < batchEnd; i++) {
        const { number, message, qrData } = messages[i];
        
        // Format phone number
        const formattedNumber = number.startsWith('+') 
          ? number.substring(1) + '@c.us' 
          : number + '@c.us';
        
        try {
          // Check if this message should include a QR code
          if (qrData) {
            try {
              // Generate QR code
              const qrImageBuffer = await generateQRCode(qrData);
              
              if (qrImageBuffer) {
                // Create media from buffer
                const media = new MessageMedia(
                  'image/png', 
                  qrImageBuffer.toString('base64'), 
                  'qrcode.png'
                );
                
                // Send the image with message as caption
                await client.sendMessage(formattedNumber, media, { caption: message });
                
                successCount++;
                log(`✅ Sent QR image message to ${number} (${i+1}/${messages.length})`);
              } else {
                // QR generation failed, send text only
                await client.sendMessage(formattedNumber, message);
                successCount++;
                log(`⚠️ QR generation failed for ${number}, sent text only (${i+1}/${messages.length})`);
              }
            } catch (qrError) {
              // If QR generation errors, fall back to text message
              log(`⚠️ QR error for ${number}: ${qrError.message}, sending text only`);
              await client.sendMessage(formattedNumber, message);
              successCount++;
            }
          } else {
            // Send simple text message (no QR)
            await client.sendMessage(formattedNumber, message);
            successCount++;
            log(`✅ Sent text message to ${number} (${i+1}/${messages.length})`);
          }
        } catch (error) {
          failCount++;
          log(`❌ Failed to send message to ${number}: ${error.message} (${i+1}/${messages.length})`);
        }
        
        // Add delay between messages - more consistent delay
        if (i < batchEnd - 1) {
          await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
        }
      }
      
      // Log batch completion
      log(`✅ Batch ${Math.floor(batchStart/BATCH_SIZE) + 1} completed: ${successCount} success, ${failCount} fail so far`);
      
      // Add delay between batches (only if there are more batches to process)
      if (batchEnd < messages.length) {
        log(`⏳ Waiting ${BATCH_DELAY/1000} seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }
    
    // Log final results
    log(`✅ Message sending completed: ${successCount} successful, ${failCount} failed`);
    
  } catch (error) {
    log(`❌ Error in message sending API: ${error.message}`);
  }
});

// New endpoint specifically for handling bulk messages with batching
// app.post('/api/send-bulk', async (req, res) => {
//   // Check if WhatsApp is connected
//   if (!isLoggedIn || !client) {
//     return res.status(403).json({
//       success: false, 
//       message: 'WhatsApp not connected. Please scan QR code first.'
//     });
//   }

//   try {
//     // Get the messages array from request body
//     const { messages, total } = req.body;
    
//     if (!messages || !Array.isArray(messages) || messages.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid request. Please provide an array of messages.'
//       });
//     }

//     // Immediately respond to prevent timeout
//     res.status(202).json({
//       success: true,
//       message: `Processing ${messages.length} messages in batches`,
//       queued: messages.length
//     });

//     // Implementation of improved batching mechanism
//     const BATCH_SIZE = 20; // Send 20 messages per batch
//     const BATCH_DELAY = 5000; // 5 seconds between batches
//     const MESSAGE_DELAY = 1500; // 1.5 seconds between messages
    
//     // Track success and failure
//     let successCount = 0;
//     let failCount = 0;
    
//     // Process messages in batches
//     for (let batchStart = 0; batchStart < messages.length; batchStart += BATCH_SIZE) {
//       const batchEnd = Math.min(batchStart + BATCH_SIZE, messages.length);
//       log(`📦 Processing batch ${Math.floor(batchStart/BATCH_SIZE) + 1}: messages ${batchStart+1} to ${batchEnd}`);
      
//       // Process current batch
//       for (let i = batchStart; i < batchEnd; i++) {
//         const { number, message } = messages[i];
        
//         // Format phone number
//         const formattedNumber = number.startsWith('+') 
//           ? number.substring(1) + '@c.us' 
//           : number + '@c.us';
        
//         try {
//           // Send text message
//           await client.sendMessage(formattedNumber, message);
//           successCount++;
//           log(`✅ Sent message to ${number} (${i+1}/${messages.length})`);
//         } catch (error) {
//           failCount++;
//           log(`❌ Failed to send message to ${number}: ${error.message} (${i+1}/${messages.length})`);
//         }
        
//         // Add delay between messages - longer and more consistent delay
//         if (i < batchEnd - 1) {
//           await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
//         }
//       }
      
//       // Log batch completion
//       log(`✅ Batch ${Math.floor(batchStart/BATCH_SIZE) + 1} completed: ${successCount} success, ${failCount} fail so far`);
      
//       // Add delay between batches (only if there are more batches to process)
//       if (batchEnd < messages.length) {
//         log(`⏳ Waiting ${BATCH_DELAY/1000} seconds before next batch...`);
//         await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
//       }
//     }
    
//     // Log final results
//     log(`✅ Message sending completed: ${successCount} successful, ${failCount} failed`);
    
//   } catch (error) {
//     log(`❌ Error in bulk messaging API: ${error.message}`);
//   }
// });
// Endpoint for sending bulk messages optimized for speed
// app.post('/api/send-bulk', async (req, res) => {
//   // Check if WhatsApp is connected
//   if (!isLoggedIn || !client) {
//     return res.status(403).json({
//       success: false, 
//       message: 'WhatsApp not connected. Please scan QR code first.'
//     });
//   }

//   try {
//     // Get the messages array from request body
//     const { messages, batchNumber, totalBatches } = req.body;
    
//     if (!messages || !Array.isArray(messages) || messages.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid request. Please provide an array of messages.'
//       });
//     }

//     // Immediately respond to prevent timeout
//     res.status(202).json({
//       success: true,
//       message: `Processing batch ${batchNumber || 1} of ${totalBatches || 1} with ${messages.length} messages`,
//       queued: messages.length
//     });

//     // Implementation of speed-optimized batching mechanism
//     const MESSAGE_BATCH_SIZE = 10; // Process 10 messages at a time (increased from 5)
//     const BATCH_DELAY = 2000; // 2 seconds between batches (reduced from 8)
//     const MESSAGE_DELAY = 1000; // 1 second between messages (reduced from 3)
//     const MAX_RETRIES = 1; // Only retry once to maintain speed
    
//     // Track success and failure
//     let successCount = 0;
//     let failCount = 0;
    
//     // Helper function to send a single message with minimal retry
//     async function sendMessageWithRetry(number, message, retryCount = 0) {
//       try {
//         // Format phone number
//         const formattedNumber = number.startsWith('+') 
//           ? number.substring(1) + '@c.us' 
//           : number + '@c.us';
        
//         // Send message
//         await client.sendMessage(formattedNumber, message);
//         successCount++;
//         log(`✅ Sent message to ${number}`);
//         return true;
//       } catch (error) {
//         if (retryCount < MAX_RETRIES) {
//           // Quick retry once
//           await new Promise(resolve => setTimeout(resolve, 500));
//           return sendMessageWithRetry(number, message, retryCount + 1);
//         } else {
//           failCount++;
//           log(`❌ Failed to send message to ${number}: ${error.message}`);
//           return false;
//         }
//       }
//     }
    
//     // Process messages in optimal-sized batches
//     for (let batchStart = 0; batchStart < messages.length; batchStart += MESSAGE_BATCH_SIZE) {
//       const batchEnd = Math.min(batchStart + MESSAGE_BATCH_SIZE, messages.length);
      
//       // Process current batch
//       for (let i = batchStart; i < batchEnd; i++) {
//         const { number, message } = messages[i];
        
//         // Send the message with minimal retry
//         await sendMessageWithRetry(number, message);
        
//         // Add minimal delay between messages
//         if (i < batchEnd - 1) {
//           await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
//         }
//       }
      
//       // Add minimal delay between batches (only if there are more to process)
//       if (batchEnd < messages.length) {
//         await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
//       }
//     }
    
//     // Log final results
//     log(`✅ Message sending completed: ${successCount} successful, ${failCount} failed`);
    
//   } catch (error) {
//     log(`❌ Error in bulk messaging API: ${error.message}`);
//   }
// });
// BACKEND API ENDPOINT
app.post('/api/send-bulk', async (req, res) => {
  // Check if WhatsApp is connected
  if (!isLoggedIn || !client) {
    return res.status(403).json({ success: false, message: 'WhatsApp not connected. Please scan QR code first.' });
  }
  
  try {
    // Get the messages array from request body
    const { messages, batchNumber, totalBatches } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid request. Please provide an array of messages.' });
    }
    
    // Send a quick acknowledgment response to prevent timeout
    // This is important for Render's limitations
    res.status(202).json({ 
      success: true, 
      message: `Processing batch ${batchNumber || 1} of ${totalBatches || 1} with ${messages.length} messages`,
      queued: messages.length 
    });
    
    // Create a results array to track delivery status
    const results = [];
    
    // Implementation with better speed but still reliable
    const MESSAGE_BATCH_SIZE = 8;  // Process 8 messages at a time (balanced)
    const BATCH_DELAY = 1500;      // 1.5 seconds between batches
    const MESSAGE_DELAY = 800;     // 0.8 seconds between messages
    const MAX_RETRIES = 1;         // Only retry once for speed
    
    // Helper function to send a single message with minimal retry
    async function sendMessageWithRetry(number, message, retryCount = 0) {
      try {
        // Format phone number
        const formattedNumber = number.startsWith('+') ? number.substring(1) + '@c.us' : number + '@c.us';
        
        // Send message and verify success
        const response = await client.sendMessage(formattedNumber, message);
        
        // Basic verification
        if (!response) {
          throw new Error('No response from WhatsApp client');
        }
        
        log(`✅ Sent message to ${number}`);
        
        results.push({
          number,
          status: 'success'
        });
        
        return true;
      } catch (error) {
        log(`⚠️ Error sending to ${number}: ${error.message}`);
        
        if (retryCount < MAX_RETRIES) {
          // Quick retry with minimal delay
          await new Promise(resolve => setTimeout(resolve, 700));
          return sendMessageWithRetry(number, message, retryCount + 1);
        } else {
          log(`❌ Failed to send message to ${number}`);
          
          results.push({
            number,
            status: 'failed'
          });
          
          return false;
        }
      }
    }
    
    // Process messages in optimized batches
    let successCount = 0;
    let failCount = 0;
    
    // Use Promise.all for parallel processing within each batch
    for (let batchStart = 0; batchStart < messages.length; batchStart += MESSAGE_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + MESSAGE_BATCH_SIZE, messages.length);
      const batchPromises = [];
      
      // Create promises for current batch
      for (let i = batchStart; i < batchEnd; i++) {
        const { number, message } = messages[i];
        
        // Add slight staggering for network efficiency
        const staggerDelay = (i - batchStart) * MESSAGE_DELAY;
        
        batchPromises.push(
          new Promise(async (resolve) => {
            // Stagger the start of each message
            await new Promise(r => setTimeout(r, staggerDelay));
            const success = await sendMessageWithRetry(number, message);
            if (success) successCount++;
            else failCount++;
            resolve();
          })
        );
      }
      
      // Wait for all messages in batch to complete
      await Promise.all(batchPromises);
      
      log(`📦 Batch progress: ${Math.min(batchEnd, messages.length)}/${messages.length} processed`);
      
      // Add delay between batches (only if there are more to process)
      if (batchEnd < messages.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }
    
    log(`✅ Message sending completed: ${successCount} successful, ${failCount} failed`);
    
  } catch (error) {
    log(`❌ Error in bulk messaging API: ${error.message}`);
  }
});
// New endpoint for bulk messages with QR codes
// app.post('/api/send-bulk-qr', async (req, res) => {
//   // Check if WhatsApp is connected
//   if (!isLoggedIn || !client) {
//     return res.status(403).json({
//       success: false,
//       message: 'WhatsApp not connected. Please scan QR code first.'
//     });
//   }

//   try {
//     // Get the messages array from request body
//     const { messages, total } = req.body;
    
//     if (!messages || !Array.isArray(messages) || messages.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid request. Please provide an array of messages.'
//       });
//     }

//     // Immediately respond to prevent timeout
//     res.status(202).json({
//       success: true,
//       message: `Processing ${messages.length} messages with QR codes in batches`,
//       queued: messages.length
//     });

//     // Implementation of improved batching mechanism for QR messages
//     const BATCH_SIZE = 15; // Smaller batch size for QR messages
//     const BATCH_DELAY = 8000; // 8 seconds between batches (longer for QR messages)
//     const MESSAGE_DELAY = 2000; // 2 seconds between messages (QR generation takes time)
    
//     // Track success and failure
//     let successCount = 0;
//     let failCount = 0;
    
//     // Process messages in batches
//     for (let batchStart = 0; batchStart < messages.length; batchStart += BATCH_SIZE) {
//       const batchEnd = Math.min(batchStart + BATCH_SIZE, messages.length);
//       log(`📦 Processing QR batch ${Math.floor(batchStart/BATCH_SIZE) + 1}: messages ${batchStart+1} to ${batchEnd}`);
      
//       // Process current batch
//       for (let i = batchStart; i < batchEnd; i++) {
//         const { number, message, qrData } = messages[i];
        
//         // Format phone number
//         const formattedNumber = number.startsWith('+') 
//           ? number.substring(1) + '@c.us' 
//           : number + '@c.us';
        
//         try {
//           // Handle message with or without QR
//           if (qrData) {
//             try {
//               // Generate QR code
//               const qrImageBuffer = await generateQRCode(qrData);
              
//               if (qrImageBuffer) {
//                 // Create media from buffer
//                 const media = new MessageMedia(
//                   'image/png', 
//                   qrImageBuffer.toString('base64'), 
//                   'qrcode.png'
//                 );
                
//                 // Send the image with message as caption
//                 await client.sendMessage(formattedNumber, media, { caption: message });
                
//                 successCount++;
//                 log(`✅ Sent QR image message to ${number} (${i+1}/${messages.length})`);
//               } else {
//                 // QR generation failed, send text only
//                 await client.sendMessage(formattedNumber, message);
//                 successCount++;
//                 log(`⚠️ QR generation failed for ${number}, sent text only (${i+1}/${messages.length})`);
//               }
//             } catch (qrError) {
//               // If QR generation errors, fall back to text message
//               log(`⚠️ QR error for ${number}: ${qrError.message}, sending text only`);
//               await client.sendMessage(formattedNumber, message);
//               successCount++;
//             }
//           } else {
//             // Send simple text message (no QR)
//             await client.sendMessage(formattedNumber, message);
//             successCount++;
//             log(`✅ Sent text message to ${number} (${i+1}/${messages.length})`);
//           }
//         } catch (error) {
//           failCount++;
//           log(`❌ Failed to send message to ${number}: ${error.message} (${i+1}/${messages.length})`);
//         }
        
//         // Add delay between messages - longer delay for QR messages
//         if (i < batchEnd - 1) {
//           await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
//         }
//       }
      
//       // Log batch completion
//       log(`✅ QR Batch ${Math.floor(batchStart/BATCH_SIZE) + 1} completed: ${successCount} success, ${failCount} fail so far`);
      
//       // Add delay between batches (only if there are more batches to process)
//       if (batchEnd < messages.length) {
//         log(`⏳ Waiting ${BATCH_DELAY/1000} seconds before next batch...`);
//         await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
//       }
//     }
    
//     // Log final results
//     log(`✅ QR message sending completed: ${successCount} successful, ${failCount} failed`);
    
//   } catch (error) {
//     log(`❌ Error in QR bulk messaging API: ${error.message}`);
//   }
// });
// Improved bulk QR message sending endpoint
app.post('/api/send-bulk-qr', async (req, res) => {
  // Check if WhatsApp is connected
  if (!isLoggedIn || !client) {
    return res.status(403).json({
      success: false,
      message: 'WhatsApp not connected. Please scan QR code first.'
    });
  }

  try {
    // Get the messages array from request body
    const { messages, total, batchNumber, totalBatches } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request. Please provide an array of messages.'
      });
    }

    // Log batch receipt
    log(`📥 Received QR batch ${batchNumber || '?'}/${totalBatches || '?'} with ${messages.length} messages`);

    // Immediately respond to prevent timeout
    res.status(202).json({
      success: true,
      message: `Processing ${messages.length} messages with QR codes`,
      batchNumber: batchNumber || 1,
      totalBatches: totalBatches || 1,
      queued: messages.length
    });

    // Implementation of improved batching mechanism for QR messages
    const BATCH_SIZE = 5; // Smaller batch size within the server for better reliability
    const MESSAGE_DELAY = 3000; // 3 seconds between messages (QR generation takes time)
    const SUB_BATCH_DELAY = 12000; // 12 seconds between sub-batches
    
    // Track success and failure
    let successCount = 0;
    let failCount = 0;
    
    // Process messages in smaller sub-batches for better reliability
    for (let subBatchStart = 0; subBatchStart < messages.length; subBatchStart += BATCH_SIZE) {
      const subBatchEnd = Math.min(subBatchStart + BATCH_SIZE, messages.length);
      log(`📦 Processing QR sub-batch: messages ${subBatchStart+1} to ${subBatchEnd} of batch ${batchNumber || '?'}`);
      
      // Process current sub-batch
      for (let i = subBatchStart; i < subBatchEnd; i++) {
        const { id, number, message, qrData } = messages[i];
        
        // Format phone number
        let formattedNumber;
        try {
          // Handle various phone number formats
          if (number.includes('@c.us')) {
            formattedNumber = number; // Already formatted
          } else if (number.startsWith('+')) {
            formattedNumber = number.substring(1) + '@c.us';
          } else {
            formattedNumber = number + '@c.us';
          }
          
          // Validate number format
          if (!formattedNumber.match(/^\d+@c\.us$/)) {
            throw new Error('Invalid phone number format');
          }
        } catch (numError) {
          failCount++;
          log(`❌ Invalid number format: ${number}`);
          continue; // Skip this message and move to next
        }
        
        // We'll make multiple attempts for each message
        let success = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 2;
        
        while (!success && attempts < MAX_ATTEMPTS) {
          attempts++;
          try {
            // Handle message with or without QR
            if (qrData) {
              try {
                // Generate QR code with exponential backoff
                let qrImageBuffer = null;
                let qrAttempt = 0;
                
                while (!qrImageBuffer && qrAttempt < 2) {
                  try {
                    qrImageBuffer = await generateQRCode(qrData);
                    
                    if (!qrImageBuffer) {
                      throw new Error('QR generation returned null');
                    }
                  } catch (qrGenError) {
                    qrAttempt++;
                    if (qrAttempt < 2) {
                      // Wait before retrying QR generation
                      await new Promise(resolve => setTimeout(resolve, 2000));
                      log(`⚠️ Retrying QR generation for message ${i+1} (attempt ${qrAttempt+1})`);
                    } else {
                      throw qrGenError; // Propagate error after max attempts
                    }
                  }
                }
                
                if (qrImageBuffer) {
                  // Create media from buffer
                  const media = new MessageMedia(
                    'image/png', 
                    qrImageBuffer.toString('base64'), 
                    'qrcode.png'
                  );
                  
                  // Send the image with message as caption
                  await client.sendMessage(formattedNumber, media, { caption: message });
                  
                  successCount++;
                  success = true;
                  log(`✅ Sent QR image message to ${number} (${i+1}/${messages.length})`);
                } else {
                  // QR generation failed, send text only
                  await client.sendMessage(formattedNumber, message);
                  successCount++;
                  success = true;
                  log(`⚠️ QR generation failed for ${number}, sent text only (${i+1}/${messages.length})`);
                }
              } catch (qrError) {
                if (attempts >= MAX_ATTEMPTS) {
                  // If QR generation errors after all attempts, fall back to text message
                  log(`⚠️ QR error for ${number} after ${attempts} attempts: ${qrError.message}, sending text only`);
                  try {
                    await client.sendMessage(formattedNumber, message);
                    successCount++;
                    success = true;
                    log(`✅ Sent fallback text message to ${number} (${i+1}/${messages.length})`);
                  } catch (textError) {
                    failCount++;
                    log(`❌ Failed to send text message to ${number}: ${textError.message}`);
                  }
                } else {
                  // Wait before retry
                  log(`⚠️ QR error for ${number} (attempt ${attempts}): ${qrError.message}, will retry`);
                  await new Promise(resolve => setTimeout(resolve, 3000));
                }
              }
            } else {
              // Send simple text message (no QR)
              await client.sendMessage(formattedNumber, message);
              successCount++;
              success = true;
              log(`✅ Sent text message to ${number} (${i+1}/${messages.length})`);
            }
          } catch (error) {
            if (attempts >= MAX_ATTEMPTS) {
              failCount++;
              log(`❌ Failed to send message to ${number} after ${MAX_ATTEMPTS} attempts: ${error.message}`);
            } else {
              // Wait before retry
              await new Promise(resolve => setTimeout(resolve, 3000));
              log(`⚠️ Failed attempt ${attempts} for ${number}: ${error.message}, will retry`);
            }
          }
        }
        
        // Add delay between messages - longer delay for QR messages
        if (i < subBatchEnd - 1) {
          await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
        }
      }
      
      // Log sub-batch completion
      log(`✅ QR Sub-Batch completed: ${successCount} success, ${failCount} fail so far`);
      
      // Add delay between sub-batches (only if there are more sub-batches to process)
      if (subBatchEnd < messages.length) {
        log(`⏳ Waiting ${SUB_BATCH_DELAY/1000} seconds before next sub-batch...`);
        await new Promise(resolve => setTimeout(resolve, SUB_BATCH_DELAY));
      }
    }
    
    // Log final results for this batch
    log(`✅ QR batch ${batchNumber || '?'} completed: ${successCount} successful, ${failCount} failed`);
    
  } catch (error) {
    log(`❌ Error in QR bulk messaging API: ${error.message}`);
  }
});
// Force QR code regeneration (reset and reinitialize)
app.post('/reset', async (req, res) => {
  log('🔄 Manual reset requested...');

  // Stop any monitoring
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }

  // Stop active connection checks
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }

  // Clear any pending reconnection
  if (reconnectionTimer) {
    clearTimeout(reconnectionTimer);
    reconnectionTimer = null;
  }

  // Destroy client if it exists
  await destroyClient();
  
  // Reset state variables
  isLoggedIn = false;
  qrCodeData = '';
  connectionState = 'RESETTING';
  reconnectionAttempts = 0;
  lastActiveTimestamp = 0;
  profilePictureUrl = '';
  loggedInName = '';
  
  // Start monitoring again
  startMonitoring();
  
  // Initialize new client after a delay
  setTimeout(() => {
    initializeWhatsAppClient();
  }, 3000);
  
  res.send('✅ WhatsApp session reset. QR code will be generated shortly.');
});

// Logout from WhatsApp (remove device from connected devices list)
app.post('/logout', async (req, res) => {
  log('🔑 WhatsApp logout requested...');
  
  if (isLoggedIn && client) {
    try {
      // First try to logout from WhatsApp Web (removes device from connected devices)
      log('📱 Sending logout command to WhatsApp Web...');
      await client.logout();
      log('✅ WhatsApp Web logout successful');
    } catch (error) {
      log(`❌ Error during WhatsApp logout: ${error.message}`);
    }
  }
  
  // Stop any monitoring
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }

  // Stop active connection checks
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }

  // Clear any pending reconnection
  if (reconnectionTimer) {
    clearTimeout(reconnectionTimer);
    reconnectionTimer = null;
  }

  // Destroy client if it exists
  await destroyClient();
  
  // Reset state variables
  isLoggedIn = false;
  qrCodeData = '';
  connectionState = 'RESETTING';
  reconnectionAttempts = 0;
  lastActiveTimestamp = 0;
  profilePictureUrl = '';
  loggedInName = '';
  
  // Start monitoring again
  startMonitoring();
  
  // Initialize new client after a delay
  setTimeout(() => {
    initializeWhatsAppClient();
  }, 3000);
  
  res.send('✅ WhatsApp session reset. QR code will be generated shortly.');
});

// Logout from WhatsApp (remove device from connected devices list)
app.post('/logout', async (req, res) => {
  log('🔑 WhatsApp logout requested...');
  
  if (isLoggedIn && client) {
    try {
      // First try to logout from WhatsApp Web (removes device from connected devices)
      log('📱 Sending logout command to WhatsApp Web...');
      await client.logout();
      log('✅ WhatsApp Web logout successful');
    } catch (error) {
      log(`❌ Error during WhatsApp logout: ${error.message}`);
    }
  }
  
  // Stop any monitoring
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }
  
  // Stop active connection checks
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }
  
  // Clear any pending reconnection
  if (reconnectionTimer) {
    clearTimeout(reconnectionTimer);
    reconnectionTimer = null;
  }
  
  // Destroy client
  await destroyClient();
  
  // Reset state variables
  isLoggedIn = false;
  qrCodeData = '';
  connectionState = 'LOGGED_OUT';
  reconnectionAttempts = 0;
  lastActiveTimestamp = 0;
  profilePictureUrl = '';
  loggedInName = '';
  
  // Start monitoring again
  startMonitoring();
  
  // Generate new QR after some delay
  setTimeout(() => {
    initializeWhatsAppClient();
  }, 3000);
  
  res.send('✅ Successfully logged out from WhatsApp. QR code will be generated shortly.');
});

// Define port and start the server
const PORT = process.env.PORT || 3000;

// Initialize WhatsApp client
initializeWhatsAppClient();

// Start monitoring
startMonitoring();

// Start the server
app.listen(PORT, () => {
  log(`🚀 Server running on port ${PORT}`);
  log(`🌐 Visit http://localhost:${PORT} to scan QR code or check status`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  log('👋 Shutting down gracefully...');
  
  // Stop timers
  if (monitoringTimer) clearInterval(monitoringTimer);
  if (connectionCheckTimer) clearInterval(connectionCheckTimer);
  if (reconnectionTimer) clearTimeout(reconnectionTimer);
  
  // Destroy client if it exists
  if (client) {
    try {
      await client.destroy();
      log('✅ WhatsApp client destroyed');
    } catch (error) {
      log(`❌ Error destroying client: ${error.message}`);
    }
  }
  
  log('✅ Goodbye!');
  process.exit(0);
});
//finish
// End of the code
