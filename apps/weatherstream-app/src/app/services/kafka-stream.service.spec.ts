import { NgZone } from '@angular/core';
import { KafkaStreamService, WeatherEvent } from './kafka-stream.service';

describe('KafkaStreamService', () => {
  let service: KafkaStreamService;
  // NgZone mock that runs callbacks synchronously
  const mockNgZone = { run: (fn: () => void) => fn() } as NgZone;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    service?.ngOnDestroy();
    vi.useRealTimers();
    delete (window as any).electronKafka;
  });

  describe('simulation mode (no Electron)', () => {
    beforeEach(() => {
      delete (window as any).electronKafka;
      service = new KafkaStreamService(mockNgZone);
    });

    it('should be created', () => {
      expect(service).toBeTruthy();
    });

    it('should detect non-Electron environment', () => {
      expect(service.isElectron()).toBe(false);
    });

    it('should start connected in simulation mode', () => {
      expect(service.connected()).toBe(true);
    });

    it('should have no events initially', () => {
      expect(service.events().length).toBe(0);
      expect(service.eventCount()).toBe(0);
    });

    it('should have no error initially', () => {
      expect(service.lastError()).toBeNull();
    });

    it('should generate events over time', () => {
      vi.advanceTimersByTime(2000);
      expect(service.eventCount()).toBe(1);
      vi.advanceTimersByTime(2000);
      expect(service.eventCount()).toBe(2);
    });

    it('should generate events with required fields', () => {
      vi.advanceTimersByTime(2000);
      const event = service.events()[0];
      expect(event.location).toBeDefined();
      expect(typeof event.temperature).toBe('number');
      expect(typeof event.humidity).toBe('number');
      expect(typeof event.windSpeed).toBe('number');
      expect(event.condition).toBeDefined();
      expect(event.timestamp).toBeDefined();
    });

    it('should cap events at 100', () => {
      vi.advanceTimersByTime(2000 * 105);
      expect(service.eventCount()).toBe(100);
    });

    it('should prepend new events (newest first)', () => {
      vi.advanceTimersByTime(2000);
      const firstEvent = service.events()[0];
      vi.advanceTimersByTime(2000);
      const newestEvent = service.events()[0];
      expect(new Date(newestEvent.timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(firstEvent.timestamp).getTime()
      );
    });

    it('should clear events', () => {
      vi.advanceTimersByTime(4000);
      expect(service.eventCount()).toBeGreaterThan(0);
      service.clearEvents();
      expect(service.eventCount()).toBe(0);
    });

    it('should not call reconnect in simulation mode', async () => {
      await service.reconnect();
      expect(service.lastError()).toBeNull();
    });

    it('should stop simulation on destroy', () => {
      vi.advanceTimersByTime(2000);
      expect(service.eventCount()).toBe(1);
      service.ngOnDestroy();
      vi.advanceTimersByTime(4000);
      expect(service.eventCount()).toBe(1);
    });
  });

  describe('Electron mode', () => {
    let mockApi: {
      onWeatherEvent: ReturnType<typeof vi.fn>;
      onStatusChange: ReturnType<typeof vi.fn>;
      onError: ReturnType<typeof vi.fn>;
      getStatus: ReturnType<typeof vi.fn>;
      reconnect: ReturnType<typeof vi.fn>;
    };
    let weatherCallback: (event: WeatherEvent) => void;
    let statusCallback: (status: { connected: boolean }) => void;
    let errorCallback: (error: { message: string }) => void;

    beforeEach(() => {
      mockApi = {
        onWeatherEvent: vi.fn((cb) => {
          weatherCallback = cb;
          return vi.fn();
        }),
        onStatusChange: vi.fn((cb) => {
          statusCallback = cb;
          return vi.fn();
        }),
        onError: vi.fn((cb) => {
          errorCallback = cb;
          return vi.fn();
        }),
        getStatus: vi.fn().mockResolvedValue({ connected: true }),
        reconnect: vi.fn().mockResolvedValue(undefined),
      };

      (window as any).electronKafka = mockApi;
      service = new KafkaStreamService(mockNgZone);
    });

    it('should detect Electron environment', () => {
      expect(service.isElectron()).toBe(true);
    });

    it('should register all event listeners', () => {
      expect(mockApi.onWeatherEvent).toHaveBeenCalledOnce();
      expect(mockApi.onStatusChange).toHaveBeenCalledOnce();
      expect(mockApi.onError).toHaveBeenCalledOnce();
    });

    it('should fetch initial status', () => {
      expect(mockApi.getStatus).toHaveBeenCalledOnce();
    });

    it('should add weather events from Electron IPC', () => {
      const event: WeatherEvent = {
        location: 'Test City',
        temperature: 22.5,
        humidity: 65,
        windSpeed: 15.3,
        condition: 'Sunny',
        timestamp: new Date().toISOString(),
      };

      weatherCallback(event);

      expect(service.eventCount()).toBe(1);
      expect(service.events()[0].location).toBe('Test City');
    });

    it('should update connected status from IPC', () => {
      statusCallback({ connected: false });
      expect(service.connected()).toBe(false);

      statusCallback({ connected: true });
      expect(service.connected()).toBe(true);
    });

    it('should set error from IPC', () => {
      errorCallback({ message: 'Connection lost' });
      expect(service.lastError()).toBe('Connection lost');
    });

    it('should call reconnect on Electron API', async () => {
      await service.reconnect();
      expect(mockApi.reconnect).toHaveBeenCalledOnce();
      expect(service.lastError()).toBeNull();
    });

    it('should cleanup listeners on destroy', () => {
      service.ngOnDestroy();
      // Verify no errors thrown during cleanup
    });
  });
});
