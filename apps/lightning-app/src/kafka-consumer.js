const { Kafka } = require('kafkajs');
const EventEmitter = require('events');

class KafkaWeatherConsumer extends EventEmitter {
  constructor({ brokers, topic, groupId }) {
    super();
    this.topic = topic;
    this.connected = false;

    this.kafka = new Kafka({
      clientId: 'lightning-app',
      brokers,
      retry: { initialRetryTime: 1000, retries: 5 },
    });

    this.consumer = this.kafka.consumer({ groupId });
  }

  async connect() {
    try {
      await this.consumer.connect();
      this.connected = true;
      this.emit('connected');

      await this.consumer.subscribe({
        topic: this.topic,
        fromBeginning: false,
      });

      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const value = message.value?.toString();
            if (!value) return;

            const event = JSON.parse(value);
            this.emit('weather-event', {
              ...event,
              _meta: {
                topic,
                partition,
                offset: message.offset,
                timestamp: message.timestamp,
                receivedAt: new Date().toISOString(),
              },
            });
          } catch (err) {
            this.emit('error', new Error(`Failed to parse message: ${err.message}`));
          }
        },
      });
    } catch (err) {
      this.connected = false;
      this.emit('error', err);
      throw err;
    }
  }

  async disconnect() {
    try {
      await this.consumer.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.connected = false;
    this.emit('disconnected');
  }

  isConnected() {
    return this.connected;
  }
}

module.exports = { KafkaWeatherConsumer };
