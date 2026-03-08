using Microsoft.EntityFrameworkCore;
using WeatherApi.Models;

namespace WeatherApi.Data;

public class WeatherDbContext(DbContextOptions<WeatherDbContext> options) : DbContext(options)
{
    public DbSet<WeatherForecast> WeatherForecasts => Set<WeatherForecast>();
}
