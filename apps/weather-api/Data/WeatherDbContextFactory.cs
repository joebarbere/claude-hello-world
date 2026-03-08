using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace WeatherApi.Data;

/// <summary>
/// Design-time factory used by EF Core tooling (migrations, scaffolding).
/// Not used at runtime.
/// </summary>
public class WeatherDbContextFactory : IDesignTimeDbContextFactory<WeatherDbContext>
{
    public WeatherDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<WeatherDbContext>()
            .UseNpgsql("Host=localhost;Port=5432;Database=appdb;Username=appuser;Password=apppassword")
            .Options;
        return new WeatherDbContext(options);
    }
}
