// Import the real module for actual coverage.
// The KafkaWeatherConsumer constructor creates a Kafka client but doesn't
// connect — all IO happens in connect(). We replace the internal consumer
// property with a mock before calling any async methods.
const { KafkaWeatherConsumer } = await import('./kafka-consumer.js');

describe('KafkaWeatherConsumer', () => {
  let consumer;
  let mockConsumer;

  beforeEach(() => {
    mockConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    consumer = new KafkaWeatherConsumer({
      brokers: ['localhost:9092'],
      topic: 'weather-events',
      groupId: 'test-group',
    });

    // Replace the real kafkajs consumer with our mock before any IO
    consumer.consumer = mockConsumer;
  });

  afterEach(() => {
    consumer.removeAllListeners();
  });

  it('should create an instance with correct properties', () => {
    expect(consumer).toBeTruthy();
    expect(consumer.topic).toBe('weather-events');
    expect(consumer.isConnected()).toBe(false);
  });

  describe('connect', () => {
    it('should connect and subscribe to the topic', async () => {
      await consumer.connect();

      expect(mockConsumer.connect).toHaveBeenCalledOnce();
      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topic: 'weather-events',
        fromBeginning: false,
      });
      expect(mockConsumer.run).toHaveBeenCalledOnce();
      expect(consumer.isConnected()).toBe(true);
    });

    it('should emit "connected" event on successful connect', async () => {
      const handler = vi.fn();
      consumer.on('connected', handler);

      await consumer.connect();

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should emit "error" and throw on connect failure', async () => {
      const error = new Error('Connection refused');
      mockConsumer.connect.mockRejectedValue(error);

      const errorHandler = vi.fn();
      consumer.on('error', errorHandler);

      await expect(consumer.connect()).rejects.toThrow('Connection refused');
      expect(consumer.isConnected()).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith(error);
    });
  });

  describe('message handling', () => {
    it('should emit weather-event with parsed JSON and metadata', async () => {
      let eachMessageHandler;
      mockConsumer.run.mockImplementation(({ eachMessage }) => {
        eachMessageHandler = eachMessage;
        return Promise.resolve();
      });

      const eventHandler = vi.fn();
      consumer.on('weather-event', eventHandler);

      await consumer.connect();

      const weatherData = {
        location: 'Tokyo',
        temperature: 25,
        humidity: 60,
        windSpeed: 12,
        condition: 'Sunny',
        timestamp: '2026-03-26T10:00:00Z',
      };

      await eachMessageHandler({
        topic: 'weather-events',
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(weatherData)),
          offset: '42',
          timestamp: '1711440000000',
        },
      });

      expect(eventHandler).toHaveBeenCalledOnce();
      const emittedEvent = eventHandler.mock.calls[0][0];
      expect(emittedEvent.location).toBe('Tokyo');
      expect(emittedEvent.temperature).toBe(25);
      expect(emittedEvent._meta).toBeDefined();
      expect(emittedEvent._meta.topic).toBe('weather-events');
      expect(emittedEvent._meta.partition).toBe(0);
      expect(emittedEvent._meta.offset).toBe('42');
      expect(emittedEvent._meta.receivedAt).toBeDefined();
    });

    it('should skip messages with no value', async () => {
      let eachMessageHandler;
      mockConsumer.run.mockImplementation(({ eachMessage }) => {
        eachMessageHandler = eachMessage;
        return Promise.resolve();
      });

      const eventHandler = vi.fn();
      consumer.on('weather-event', eventHandler);

      await consumer.connect();

      await eachMessageHandler({
        topic: 'weather-events',
        partition: 0,
        message: { value: null, offset: '1', timestamp: '0' },
      });

      expect(eventHandler).not.toHaveBeenCalled();
    });

    it('should emit error on invalid JSON', async () => {
      let eachMessageHandler;
      mockConsumer.run.mockImplementation(({ eachMessage }) => {
        eachMessageHandler = eachMessage;
        return Promise.resolve();
      });

      const errorHandler = vi.fn();
      consumer.on('error', errorHandler);

      await consumer.connect();

      await eachMessageHandler({
        topic: 'weather-events',
        partition: 0,
        message: {
          value: Buffer.from('not-json'),
          offset: '1',
          timestamp: '0',
        },
      });

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler.mock.calls[0][0].message).toContain(
        'Failed to parse message'
      );
    });
  });

  describe('disconnect', () => {
    it('should disconnect and emit "disconnected"', async () => {
      const disconnectedHandler = vi.fn();
      consumer.on('disconnected', disconnectedHandler);

      await consumer.connect();
      expect(consumer.isConnected()).toBe(true);

      await consumer.disconnect();

      expect(mockConsumer.disconnect).toHaveBeenCalledOnce();
      expect(consumer.isConnected()).toBe(false);
      expect(disconnectedHandler).toHaveBeenCalledOnce();
    });

    it('should handle disconnect errors gracefully', async () => {
      mockConsumer.disconnect.mockRejectedValue(new Error('Already disconnected'));

      await consumer.connect();
      await consumer.disconnect();
      expect(consumer.isConnected()).toBe(false);
    });
  });
});
