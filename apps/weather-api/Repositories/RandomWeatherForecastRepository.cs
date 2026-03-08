using WeatherApi.Models;

namespace WeatherApi.Repositories;

/// <summary>
/// Read-only repository that generates random weather forecast data.
/// Write operations throw NotSupportedException.
/// </summary>
public class RandomWeatherForecastRepository : IWeatherForecastRepository
{
    private static readonly string[] Summaries =
    [
        "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
    ];

    public Task<IEnumerable<WeatherForecast>> GetAllAsync()
    {
        var forecasts = Enumerable.Range(1, 5).Select(i => new WeatherForecast
        {
            Id = i,
            Date = DateOnly.FromDateTime(DateTime.Now.AddDays(i)),
            TemperatureC = Random.Shared.Next(-20, 55),
            Summary = Summaries[Random.Shared.Next(Summaries.Length)]
        });
        return Task.FromResult(forecasts);
    }

    public Task<WeatherForecast?> GetByIdAsync(int id)
    {
        if (id < 1 || id > 5)
            return Task.FromResult<WeatherForecast?>(null);

        var forecast = new WeatherForecast
        {
            Id = id,
            Date = DateOnly.FromDateTime(DateTime.Now.AddDays(id)),
            TemperatureC = Random.Shared.Next(-20, 55),
            Summary = Summaries[Random.Shared.Next(Summaries.Length)]
        };
        return Task.FromResult<WeatherForecast?>(forecast);
    }

    public Task<WeatherForecast> CreateAsync(WeatherForecast forecast) =>
        throw new NotSupportedException("RandomWeatherForecastRepository is read-only.");

    public Task<WeatherForecast?> UpdateAsync(int id, WeatherForecast forecast) =>
        throw new NotSupportedException("RandomWeatherForecastRepository is read-only.");

    public Task<bool> DeleteAsync(int id) =>
        throw new NotSupportedException("RandomWeatherForecastRepository is read-only.");
}
