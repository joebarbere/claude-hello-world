using Microsoft.EntityFrameworkCore;
using WeatherApi.Data;
using WeatherApi.Models;

namespace WeatherApi.Repositories;

/// <summary>
/// Full CRUD repository backed by PostgreSQL via Entity Framework Core.
/// </summary>
public class EfWeatherForecastRepository(WeatherDbContext db) : IWeatherForecastRepository
{
    public async Task<IEnumerable<WeatherForecast>> GetAllAsync() =>
        await db.WeatherForecasts.ToListAsync();

    public async Task<WeatherForecast?> GetByIdAsync(int id) =>
        await db.WeatherForecasts.FindAsync(id);

    public async Task<WeatherForecast> CreateAsync(WeatherForecast forecast)
    {
        db.WeatherForecasts.Add(forecast);
        await db.SaveChangesAsync();
        return forecast;
    }

    public async Task<WeatherForecast?> UpdateAsync(int id, WeatherForecast forecast)
    {
        var existing = await db.WeatherForecasts.FindAsync(id);
        if (existing is null)
            return null;

        existing.Date = forecast.Date;
        existing.TemperatureC = forecast.TemperatureC;
        existing.Summary = forecast.Summary;
        await db.SaveChangesAsync();
        return existing;
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var existing = await db.WeatherForecasts.FindAsync(id);
        if (existing is null)
            return false;

        db.WeatherForecasts.Remove(existing);
        await db.SaveChangesAsync();
        return true;
    }
}
