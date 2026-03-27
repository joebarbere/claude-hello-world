const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { KafkaWeatherConsumer } = require('./kafka-consumer');

let mainWindow;
let kafkaConsumer;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Lightning — Weather Stream',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServer = process.env.WEATHERSTREAM_DEV_SERVER;
  if (devServer) {
    mainWindow.loadURL(devServer);
  } else {
    const indexPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'dist',
      'apps',
      'weatherstream-app',
      'browser',
      'index.html'
    );
    mainWindow.loadFile(indexPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function startKafkaConsumer() {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
  const topic = process.env.KAFKA_TOPIC || 'weather-events';
  const groupId = process.env.KAFKA_GROUP_ID || 'lightning-app-group';

  kafkaConsumer = new KafkaWeatherConsumer({ brokers, topic, groupId });

  kafkaConsumer.on('weather-event', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kafka:weather-event', event);
    }
  });

  kafkaConsumer.on('error', (error) => {
    console.error('[Kafka] Consumer error:', error.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kafka:error', { message: error.message });
    }
  });

  kafkaConsumer.on('connected', () => {
    console.log('[Kafka] Consumer connected');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kafka:status', { connected: true });
    }
  });

  kafkaConsumer.on('disconnected', () => {
    console.log('[Kafka] Consumer disconnected');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kafka:status', { connected: false });
    }
  });

  try {
    await kafkaConsumer.connect();
  } catch (err) {
    console.error('[Kafka] Failed to connect:', err.message);
    // App still works — UI will show disconnected state and simulated data
  }
}

// IPC handlers for renderer requests
ipcMain.handle('kafka:get-status', () => {
  return { connected: kafkaConsumer?.isConnected() ?? false };
});

ipcMain.handle('kafka:reconnect', async () => {
  if (kafkaConsumer) {
    await kafkaConsumer.disconnect();
    await kafkaConsumer.connect();
  }
});

app.whenReady().then(async () => {
  createWindow();
  await startKafkaConsumer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (kafkaConsumer) {
    await kafkaConsumer.disconnect();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
