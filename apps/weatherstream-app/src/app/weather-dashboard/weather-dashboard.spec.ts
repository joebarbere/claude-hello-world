import { WeatherDashboard } from './weather-dashboard';

describe('WeatherDashboard', () => {
  // Access methods directly from the prototype to avoid Angular DI
  // Template rendering is covered by E2E tests
  const { conditionIcon, tempColor } = WeatherDashboard.prototype;

  describe('conditionIcon', () => {
    it('should return sun icon for Sunny', () => {
      expect(conditionIcon('Sunny')).toBe('☀️');
    });

    it('should return cloud icon for Cloudy', () => {
      expect(conditionIcon('Cloudy')).toBe('☁️');
    });

    it('should return rain icon for Rainy', () => {
      expect(conditionIcon('Rainy')).toBe('🌧️');
    });

    it('should return storm icon for Stormy', () => {
      expect(conditionIcon('Stormy')).toBe('⛈️');
    });

    it('should return snow icon for Snowy', () => {
      expect(conditionIcon('Snowy')).toBe('❄️');
    });

    it('should return wind icon for Windy', () => {
      expect(conditionIcon('Windy')).toBe('💨');
    });

    it('should return fog icon for Foggy', () => {
      expect(conditionIcon('Foggy')).toBe('🌫️');
    });

    it('should return moon icon for Clear', () => {
      expect(conditionIcon('Clear')).toBe('🌙');
    });

    it('should return hail icon for Hail', () => {
      expect(conditionIcon('Hail')).toBe('🌨️');
    });

    it('should return drizzle icon for Drizzle', () => {
      expect(conditionIcon('Drizzle')).toBe('🌦️');
    });

    it('should return default thermometer icon for unknown condition', () => {
      expect(conditionIcon('Unknown')).toBe('🌡️');
      expect(conditionIcon('')).toBe('🌡️');
    });
  });

  describe('tempColor', () => {
    it('should return blue for sub-zero temps', () => {
      expect(tempColor(-5)).toBe('#3b82f6');
      expect(tempColor(-20)).toBe('#3b82f6');
      expect(tempColor(-0.1)).toBe('#3b82f6');
    });

    it('should return cyan for cool temps (0-14)', () => {
      expect(tempColor(0)).toBe('#06b6d4');
      expect(tempColor(7)).toBe('#06b6d4');
      expect(tempColor(14.9)).toBe('#06b6d4');
    });

    it('should return green for mild temps (15-24)', () => {
      expect(tempColor(15)).toBe('#22c55e');
      expect(tempColor(20)).toBe('#22c55e');
      expect(tempColor(24.9)).toBe('#22c55e');
    });

    it('should return amber for warm temps (25-34)', () => {
      expect(tempColor(25)).toBe('#f59e0b');
      expect(tempColor(30)).toBe('#f59e0b');
      expect(tempColor(34.9)).toBe('#f59e0b');
    });

    it('should return red for hot temps (35+)', () => {
      expect(tempColor(35)).toBe('#ef4444');
      expect(tempColor(40)).toBe('#ef4444');
      expect(tempColor(50)).toBe('#ef4444');
    });
  });
});
