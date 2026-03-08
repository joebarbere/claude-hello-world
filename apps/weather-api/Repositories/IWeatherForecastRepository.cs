using WeatherApi.Models;

namespace WeatherApi.Repositories;

public interface IWeatherForecastRepository
{
    Task<IEnumerable<WeatherForecast>> GetAllAsync();
    Task<WeatherForecast?> GetByIdAsync(int id);
    Task<WeatherForecast> CreateAsync(WeatherForecast forecast);
    Task<WeatherForecast?> UpdateAsync(int id, WeatherForecast forecast);
    Task<bool> DeleteAsync(int id);
}
