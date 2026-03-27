import { Injectable, NgZone, OnDestroy, signal, computed } from '@angular/core';

export interface WeatherEvent {
  location: string;
  temperature: number;
  humidity: number;
  windSpeed: number;
  condition: string;
  timestamp: string;
  _meta?: {
    topic: string;
    partition: number;
    offset: string;
    timestamp: string;
    receivedAt: string;
  };
}

interface ElectronKafkaApi {
  onWeatherEvent: (callback: (event: WeatherEvent) => void) => () => void;
  onStatusChange: (callback: (status: { connected: boolean }) => void) => () => void;
  onError: (callback: (error: { message: string }) => void) => () => void;
  getStatus: () => Promise<{ connected: boolean }>;
  reconnect: () => Promise<void>;
}

declare global {
  interface Window {
    electronKafka?: ElectronKafkaApi;
  }
}

@Injectable({ providedIn: 'root' })
export class KafkaStreamService implements OnDestroy {
  private cleanupFns: (() => void)[] = [];
  private simulationInterval: ReturnType<typeof setInterval> | null = null;

  readonly isElectron = signal(!!window.electronKafka);
  readonly connected = signal(false);
  readonly events = signal<WeatherEvent[]>([]);
  readonly lastError = signal<string | null>(null);
  readonly eventCount = computed(() => this.events().length);

  private readonly locations = [
    'New York', 'London', 'Tokyo', 'Sydney', 'Paris',
    'Berlin', 'Mumbai', 'São Paulo', 'Cairo', 'Toronto',
  ];

  private readonly conditions = [
    'Sunny', 'Cloudy', 'Rainy', 'Stormy', 'Snowy',
    'Windy', 'Foggy', 'Clear', 'Hail', 'Drizzle',
  ];

  // eslint-disable-next-line @angular-eslint/prefer-inject -- tests instantiate directly with `new KafkaStreamService(mockNgZone)`
  constructor(private ngZone: NgZone) {
    this.init();
  }

  private init() {
    if (window.electronKafka) {
      this.setupElectronListeners();
    } else {
      this.startSimulation();
    }
  }

  private setupElectronListeners() {
    const api = window.electronKafka!;

    const removeWeather = api.onWeatherEvent((event) => {
      this.ngZone.run(() => this.addEvent(event));
    });
    this.cleanupFns.push(removeWeather);

    const removeStatus = api.onStatusChange((status) => {
      this.ngZone.run(() => this.connected.set(status.connected));
    });
    this.cleanupFns.push(removeStatus);

    const removeError = api.onError((error) => {
      this.ngZone.run(() => this.lastError.set(error.message));
    });
    this.cleanupFns.push(removeError);

    api.getStatus().then((status) => {
      this.ngZone.run(() => this.connected.set(status.connected));
    });
  }

  private startSimulation() {
    this.connected.set(true);
    this.simulationInterval = setInterval(() => {
      const event = this.generateEvent();
      this.ngZone.run(() => this.addEvent(event));
    }, 2000);
  }

  private generateEvent(): WeatherEvent {
    return {
      location: this.locations[Math.floor(Math.random() * this.locations.length)],
      temperature: Math.round((Math.random() * 60 - 20) * 10) / 10,
      humidity: Math.round(Math.random() * 100),
      windSpeed: Math.round(Math.random() * 120 * 10) / 10,
      condition: this.conditions[Math.floor(Math.random() * this.conditions.length)],
      timestamp: new Date().toISOString(),
    };
  }

  private addEvent(event: WeatherEvent) {
    this.events.update((prev) => [event, ...prev].slice(0, 100));
  }

  async reconnect() {
    if (window.electronKafka) {
      this.lastError.set(null);
      await window.electronKafka.reconnect();
    }
  }

  clearEvents() {
    this.events.set([]);
  }

  ngOnDestroy() {
    this.cleanupFns.forEach((fn) => fn());
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
    }
  }
}
