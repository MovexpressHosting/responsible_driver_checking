// websocket-server.js
const WebSocket = require('ws');
const mysql = require('mysql2');
const wss = new WebSocket.Server({ port: 8080 });

// Database connection
const db = mysql.createConnection({
  host: 'localhost',
  user: 'your_username',
  password: 'your_password',
  database: 'your_database'
});

db.connect((err) => {
  if (err) {
    console.error('Database connection failed:', err);
    return;
  }
  console.log('Connected to database');
});

const clients = new Map(); // Map<bookingId, Set<WebSocket>>

// Track last checked assignment state
const lastAssignmentState = new Map();

// Function to check for driver assignment changes
async function checkDriverAssignments() {
  try {
    // Get all bookings that have clients subscribed
    if (clients.size === 0) return;

    const bookingIds = Array.from(clients.keys());
    const placeholders = bookingIds.map(() => '?').join(',');
    
    const query = `
      SELECT id, assigned_driver_id 
      FROM bookings 
      WHERE id IN (${placeholders})
    `;
    
    const [rows] = await db.promise().execute(query, bookingIds);
    
    for (const row of rows) {
      const currentDriverId = row.assigned_driver_id;
      const lastDriverId = lastAssignmentState.get(row.id);
      
      // If assignment changed and now has a driver
      if (currentDriverId && currentDriverId !== lastDriverId) {
        console.log(`Driver assignment changed for booking ${row.id}`);
        
        // Get driver details
        const driverQuery = 'SELECT id, firstname, lastname, email, phone FROM drivers WHERE id = ?';
        const [driverRows] = await db.promise().execute(driverQuery, [currentDriverId]);
        
        if (driverRows.length > 0) {
          const driver = driverRows[0];
          broadcastToBooking(row.id, {
            type: 'DRIVER_ASSIGNED',
            bookingId: row.id,
            driver: driver,
            timestamp: new Date().toISOString()
          });
        }
        
        // Update last known state
        lastAssignmentState.set(row.id, currentDriverId);
      } else if (!currentDriverId && lastDriverId) {
        // Driver was unassigned
        lastAssignmentState.set(row.id, null);
      } else if (!lastAssignmentState.has(row.id)) {
        // First time checking this booking
        lastAssignmentState.set(row.id, currentDriverId);
      }
    }
  } catch (error) {
    console.error('Error checking driver assignments:', error);
  }
}

// Function to broadcast to all clients subscribed to a booking
function broadcastToBooking(bookingId, message) {
  const subscribedClients = clients.get(bookingId);
  if (subscribedClients) {
    const messageStr = JSON.stringify(message);
    subscribedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'SUBSCRIBE_BOOKING') {
        const bookingId = data.bookingId;
        
        // Add client to booking subscription
        if (!clients.has(bookingId)) {
          clients.set(bookingId, new Set());
        }
        clients.get(bookingId).add(ws);
        
        console.log(`Client subscribed to booking ${bookingId}`);
        
        // Send current state immediately
        sendCurrentDriverState(ws, bookingId);
      }
      
      if (data.type === 'UNSUBSCRIBE_BOOKING') {
        const bookingId = data.bookingId;
        const subscribedClients = clients.get(bookingId);
        if (subscribedClients) {
          subscribedClients.delete(ws);
          if (subscribedClients.size === 0) {
            clients.delete(bookingId);
            lastAssignmentState.delete(bookingId);
          }
        }
      }
      
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });
  
  ws.on('close', () => {
    // Remove client from all subscriptions
    clients.forEach((subscribedClients, bookingId) => {
      subscribedClients.delete(ws);
      if (subscribedClients.size === 0) {
        clients.delete(bookingId);
        lastAssignmentState.delete(bookingId);
      }
    });
    console.log('Client disconnected');
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Send current driver state to client
async function sendCurrentDriverState(ws, bookingId) {
  try {
    const query = `
      SELECT b.assigned_driver_id, d.id, d.firstname, d.lastname, d.email, d.phone
      FROM bookings b
      LEFT JOIN drivers d ON b.assigned_driver_id = d.id
      WHERE b.id = ?
    `;
    
    const [rows] = await db.promise().execute(query, [bookingId]);
    
    if (rows.length > 0) {
      const response = {
        type: 'CURRENT_DRIVER_STATE',
        bookingId: bookingId,
        driver: rows[0].assigned_driver_id ? {
          id: rows[0].id,
          firstname: rows[0].firstname,
          lastname: rows[0].lastname,
          email: rows[0].email,
          phone: rows[0].phone
        } : null,
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

// Cleanup on server shutdown
process.on('SIGINT', () => {
  console.log('Shutting down WebSocket server...');
  db.end();
  wss.close();
  process.exit(0);
});

console.log('WebSocket server running on port 8080');
