using Microsoft.EntityFrameworkCore;
using WeatherApi.Data;
using WeatherApi.Models;

namespace WeatherApi.Repositories;

public class EfMinionRepository(WeatherDbContext db) : IMinionRepository
{
    public async Task<IEnumerable<Minion>> GetAllAsync() =>
        await db.Minions.OrderByDescending(m => m.CreatedAt).ToListAsync();

    public async Task<Minion?> GetByIdAsync(int id) =>
        await db.Minions.FindAsync(id);

    public async Task<Minion> CreateAsync(Minion minion)
    {
        minion.CreatedAt = DateTime.UtcNow;
        minion.UpdatedAt = DateTime.UtcNow;
        db.Minions.Add(minion);
        await db.SaveChangesAsync();
        return minion;
    }

    public async Task<Minion?> UpdateAsync(int id, Minion minion)
    {
        var existing = await db.Minions.FindAsync(id);
        if (existing is null)
            return null;

        existing.Name = minion.Name;
        existing.ScheduleType = minion.ScheduleType;
        existing.ScheduleValue = minion.ScheduleValue;
        existing.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        return existing;
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var existing = await db.Minions.FindAsync(id);
        if (existing is null)
            return false;

        db.Minions.Remove(existing);
        await db.SaveChangesAsync();
        return true;
    }

    public async Task<IEnumerable<Minion>> GetActiveAsync() =>
        await db.Minions.Where(m => m.IsActive).ToListAsync();

    public async Task<Minion?> SetActiveAsync(int id, bool isActive)
    {
        var existing = await db.Minions.FindAsync(id);
        if (existing is null)
            return null;

        existing.IsActive = isActive;
        existing.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        return existing;
    }

    public async Task UpdateLastRunAsync(int id, DateTime lastRun)
    {
        var existing = await db.Minions.FindAsync(id);
        if (existing is null)
            return;

        existing.LastRunAt = lastRun;
        await db.SaveChangesAsync();
    }
}
