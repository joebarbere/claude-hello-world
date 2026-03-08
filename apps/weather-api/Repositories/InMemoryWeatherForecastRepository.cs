using WeatherApi.Models;

namespace WeatherApi.Repositories;

/// <summary>
/// Full CRUD in-memory repository. No database connection required.
/// Data is stored per-instance; register as Singleton to persist across requests.
/// </summary>
public class InMemoryWeatherForecastRepository : IWeatherForecastRepository
{
    private readonly List<WeatherForecast> _store = [];
    private int _nextId = 1;
    private readonly Lock _lock = new();

    public Task<IEnumerable<WeatherForecast>> GetAllAsync()
    {
        lock (_lock)
        {
            return Task.FromResult<IEnumerable<WeatherForecast>>(_store.ToList());
        }
    }

    public Task<WeatherForecast?> GetByIdAsync(int id)
    {
        lock (_lock)
        {
            return Task.FromResult(_store.FirstOrDefault(f => f.Id == id));
        }
    }

    public Task<WeatherForecast> CreateAsync(WeatherForecast forecast)
    {
        lock (_lock)
        {
            forecast.Id = _nextId++;
            _store.Add(forecast);
            return Task.FromResult(forecast);
        }
    }

    public Task<WeatherForecast?> UpdateAsync(int id, WeatherForecast forecast)
    {
        lock (_lock)
        {
            var existing = _store.FirstOrDefault(f => f.Id == id);
            if (existing is null)
                return Task.FromResult<WeatherForecast?>(null);

            existing.Date = forecast.Date;
            existing.TemperatureC = forecast.TemperatureC;
            existing.Summary = forecast.Summary;
            return Task.FromResult<WeatherForecast?>(existing);
        }
    }

    public Task<bool> DeleteAsync(int id)
    {
        lock (_lock)
        {
            var existing = _store.FirstOrDefault(f => f.Id == id);
            if (existing is null)
                return Task.FromResult(false);

            _store.Remove(existing);
            return Task.FromResult(true);
        }
    }
}
