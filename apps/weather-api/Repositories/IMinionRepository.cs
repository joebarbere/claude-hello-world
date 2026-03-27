using WeatherApi.Models;

namespace WeatherApi.Repositories;

public interface IMinionRepository
{
    Task<IEnumerable<Minion>> GetAllAsync();
    Task<Minion?> GetByIdAsync(int id);
    Task<Minion> CreateAsync(Minion minion);
    Task<Minion?> UpdateAsync(int id, Minion minion);
    Task<bool> DeleteAsync(int id);
    Task<IEnumerable<Minion>> GetActiveAsync();
    Task<Minion?> SetActiveAsync(int id, bool isActive);
    Task UpdateLastRunAsync(int id, DateTime lastRun);
}
