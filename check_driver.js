const WebSocket = require('ws');
const mysql = require('mysql2');

// Create WebSocket server on port provided by Render or default to 8080
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ 
  port: PORT,
  host: '0.0.0.0' // Important for Render
});

console.log(`WebSocket server starting on port ${PORT}`);

// Database connection using Render environment variables
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'srv657.hstgr.io',
  user: process.env.DB_USER || 'u442108067_mydb',
  password: process.env.DB_PASSWORD || 'mOhe6ln0iP>',
  database: process.env.DB_NAME || 'u442108067_mydb',
  port: process.env.DB_PORT || 3306
});

db.connect((err) => {
  if (err) {
    console.error('Database connection failed:', err);
    return;
  }
  console.log('Connected to database');
});

const clients = new Map();
const lastAssignmentState = new Map();

// Function to check for driver assignment changes
async function checkDriverAssignments() {
  try {
    if (clients.size === 0) {
      console.log('No clients subscribed, skipping check');
      return;
    }

    const bookingIds = Array.from(clients.keys());
    const placeholders = bookingIds.map(() => '?').join(',');
    
    const query = `
      SELECT id, assigned_driver_id 
      FROM bookings 
      WHERE id IN (${placeholders})
    `;
    
    const [rows] = await db.promise().execute(query, bookingIds);
    
    console.log(`Checking ${rows.length} bookings for driver assignment changes`);
    
    for (const row of rows) {
      const currentDriverId = row.assigned_driver_id;
      const lastDriverId = lastAssignmentState.get(row.id);
      
      console.log(`Booking ${row.id}: currentDriverId=${currentDriverId}, lastDriverId=${lastDriverId}`);
      
      // Check if driver assignment changed (including from 0 to a driver ID or vice versa)
      if (currentDriverId !== lastDriverId) {
        console.log(`Driver assignment changed for booking ${row.id}: ${lastDriverId} -> ${currentDriverId}`);
        
        if (currentDriverId && currentDriverId !== 0) {
          // A driver has been assigned (not 0)
          console.log(`Fetching driver details for driver ID: ${currentDriverId}`);
          const driverQuery = 'SELECT id, firstname, lastname, email, phone FROM drivers WHERE id = ?';
          const [driverRows] = await db.promise().execute(driverQuery, [currentDriverId]);
          
          if (driverRows.length > 0) {
            const driver = driverRows[0];
            console.log(`Broadcasting driver assignment: ${driver.firstname} ${driver.lastname} for booking ${row.id}`);
            
            broadcastToBooking(row.id, {
              type: 'DRIVER_ASSIGNED',
              bookingId: row.id,
              driver: driver,
              timestamp: new Date().toISOString()
            });
          } else {
            console.log(`Driver with ID ${currentDriverId} not found in drivers table`);
            
            // Still broadcast the change but with null driver
            broadcastToBooking(row.id, {
              type: 'DRIVER_ASSIGNED',
              bookingId: row.id,
              driver: null,
              timestamp: new Date().toISOString()
            });
          }
        } else if (currentDriverId === 0 || currentDriverId === null) {
          // Driver was removed or reset to 0
          console.log(`Driver removed from booking ${row.id}`);
          
          broadcastToBooking(row.id, {
            type: 'DRIVER_ASSIGNED',
            bookingId: row.id,
            driver: null,
            timestamp: new Date().toISOString()
          });
        }
        
        lastAssignmentState.set(row.id, currentDriverId);
      } else if (!lastAssignmentState.has(row.id)) {
        // Initial state - store the current state
        lastAssignmentState.set(row.id, currentDriverId);
        console.log(`Initial state for booking ${row.id}: assigned_driver_id = ${currentDriverId}`);
      }
    }
  } catch (error) {
    console.error('Error checking driver assignments:', error);
  }
}

function broadcastToBooking(bookingId, message) {
  const subscribedClients = clients.get(bookingId);
  if (subscribedClients) {
    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    
    subscribedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
        sentCount++;
      }
    });
    
    console.log(`Broadcasted message to ${sentCount} clients for booking ${bookingId}`);
  } else {
    console.log(`No subscribed clients for booking ${bookingId}`);
  }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received message:', data);
      
      if (data.type === 'SUBSCRIBE_BOOKING') {
        const bookingId = data.bookingId;
        
        if (!clients.has(bookingId)) {
          clients.set(bookingId, new Set());
        }
        clients.get(bookingId).add(ws);
        
        console.log(`Client subscribed to booking ${bookingId}`);
        console.log(`Total clients for booking ${bookingId}: ${clients.get(bookingId).size}`);
        
        // Send current driver state immediately
        sendCurrentDriverState(ws, bookingId);
      }
      
      if (data.type === 'UNSUBSCRIBE_BOOKING') {
        const bookingId = data.bookingId;
        const subscribedClients = clients.get(bookingId);
        if (subscribedClients) {
          subscribedClients.delete(ws);
          console.log(`Client unsubscribed from booking ${bookingId}`);
          if (subscribedClients.size === 0) {
            clients.delete(bookingId);
            lastAssignmentState.delete(bookingId);
            console.log(`No more clients for booking ${bookingId}, removed from tracking`);
          }
        }
      }
      
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected, cleaning up subscriptions');
    clients.forEach((subscribedClients, bookingId) => {
      const beforeSize = subscribedClients.size;
      subscribedClients.delete(ws);
      const afterSize = subscribedClients.size;
      
      if (afterSize === 0) {
        clients.delete(bookingId);
        lastAssignmentState.delete(bookingId);
        console.log(`Removed booking ${bookingId} from tracking (no more clients)`);
      } else if (afterSize < beforeSize) {
        console.log(`Removed disconnected client from booking ${bookingId}, ${afterSize} clients remaining`);
      }
    });
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Send current driver state to client
async function sendCurrentDriverState(ws, bookingId) {
  try {
    console.log(`Sending current driver state for booking ${bookingId}`);
    
    const query = `
      SELECT b.assigned_driver_id, d.id, d.firstname, d.lastname, d.email, d.phone
      FROM bookings b
      LEFT JOIN drivers d ON b.assigned_driver_id = d.id AND b.assigned_driver_id != 0
      WHERE b.id = ?
    `;
    
    const [rows] = await db.promise().execute(query, [bookingId]);
    
    if (rows.length > 0) {
      const row = rows[0];
      const hasDriver = (row.assigned_driver_id && row.assigned_driver_id !== 0);
      
      const response = {
        type: 'CURRENT_DRIVER_STATE',
        bookingId: bookingId,
        driver: hasDriver ? {
          id: row.id,
          firstname: row.firstname,
          lastname: row.lastname,
          email: row.email,
          phone: row.phone
        } : null,
        timestamp: new Date().toISOString()
      };
      
      console.log(`Current driver state for booking ${bookingId}:`, 
        hasDriver ? `${row.firstname} ${row.lastname}` : 'No driver (0 or null)');
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
        console.log(`Sent current driver state to client for booking ${bookingId}`);
      } else {
        console.log(`WebSocket not open, cannot send state for booking ${bookingId}`);
      }
    } else {
      console.log(`No booking found with ID: ${bookingId}`);
      
      // Send null driver state if booking not found
      const response = {
        type: 'CURRENT_DRIVER_STATE',
        bookingId: bookingId,
        driver: null,
        timestamp: new Date().toISOString()
      };
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    }
  } catch (error) {
    console.error('Error sending current driver state:', error);
  }
}

// Poll database every 2 seconds for changes
setInterval(checkDriverAssignments, 2000);
console.log('Started polling for driver assignment changes every 2 seconds');

// Health check endpoint for Render
const http = require('http');
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(8081, '0.0.0.0', () => {
  console.log('Health check server running on port 8081');
});

console.log('WebSocket server running on port', PORT);

// Server status logging
setInterval(() => {
  console.log(`Server status: ${clients.size} bookings being tracked, ${Array.from(clients.values()).reduce((acc, set) => acc + set.size, 0)} total clients`);
}, 30000); // Log every 30 seconds

// Cleanup
process.on('SIGINT', () => {
  console.log('Shutting down WebSocket server...');
  db.end();
  wss.close();
  healthServer.close();
  process.exit(0);
});
