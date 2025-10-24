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
      
      if (currentDriverId && currentDriverId !== lastDriverId) {
        console.log(`Driver assignment changed for booking ${row.id}`);
        
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
        
        lastAssignmentState.set(row.id, currentDriverId);
      } else if (!currentDriverId && lastDriverId) {
        lastAssignmentState.set(row.id, null);
      } else if (!lastAssignmentState.has(row.id)) {
        lastAssignmentState.set(row.id, currentDriverId);
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
        
        if (!clients.has(bookingId)) {
          clients.set(bookingId, new Set());
        }
        clients.get(bookingId).add(ws);
        
        console.log(`Client subscribed to booking ${bookingId}`);
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

// Cleanup
process.on('SIGINT', () => {
  console.log('Shutting down WebSocket server...');
  db.end();
  wss.close();
  healthServer.close();
  process.exit(0);
});
