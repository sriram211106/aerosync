import { pool } from '@/lib/db';
import { requireRole } from '@/lib/auth';

// GET /api/dashboard  -> the analytical queries (JOIN, GROUP BY, HAVING, ORDER BY,
// aggregate functions, subqueries) shown as panels on the dashboard.
export async function GET() {
  const { error } = await requireRole();
  if (error) return error;

  const [[totals], [gates], [airlines], [unassigned], [busyCrew], [lowBattery], [audit]] = await Promise.all([
    // 1. KPI cards: aggregates with conditional SUM
    pool.query(
      `SELECT COUNT(*) AS total_flights,
              SUM(status = 'Delayed') AS delayed,
              SUM(gate_id IS NULL AND status <> 'Cancelled') AS unassigned,
              ROUND(AVG(delay_minutes), 1) AS avg_delay
         FROM Flights`
    ),
    // 2. Gate utilisation from a view, ORDER BY
    pool.query('SELECT * FROM vw_gate_utilization ORDER BY busy_minutes DESC, gate_code'),
    // 3. JOIN + GROUP BY + HAVING + aggregates
    pool.query(
      `SELECT a.airline_name, COUNT(*) AS flights,
              ROUND(AVG(f.delay_minutes), 1) AS avg_delay,
              MAX(f.delay_minutes) AS worst_delay
         FROM Airlines a
         JOIN Flights f ON f.airline_id = a.airline_id
        GROUP BY a.airline_id, a.airline_name
       HAVING COUNT(*) > 1
        ORDER BY flights DESC, avg_delay DESC`
    ),
    // 4. simple filter: flights still waiting for a gate
    pool.query(
      `SELECT flight_id, flight_number, aircraft_type, aircraft_wingspan
         FROM Flights WHERE gate_id IS NULL AND status <> 'Cancelled'
        ORDER BY arr_time`
    ),
    // 5. subquery: crew busier than the average crew member
    pool.query(
      `SELECT name, tasks_assigned, task_minutes
         FROM vw_crew_workload
        WHERE tasks_assigned > (SELECT AVG(tasks_assigned) FROM vw_crew_workload)
        ORDER BY tasks_assigned DESC`
    ),
    // 6. JOIN + filter: tracking devices that need charging
    pool.query(
      `SELECT c.name, d.hardware_mac, d.battery_level
         FROM Tracking_Devices d
         JOIN Ground_Crew c ON c.crew_id = d.crew_id
        WHERE d.battery_level < 20
        ORDER BY d.battery_level`
    ),
    // 7. trigger output: latest audit rows with flight + gate names (multiple LEFT JOINs)
    pool.query(
      `SELECT fa.audit_id, f.flight_number,
              CONCAT_WS('-', g1.terminal, g1.gate_code) AS old_gate,
              CONCAT_WS('-', g2.terminal, g2.gate_code) AS new_gate,
              fa.old_dep, fa.new_dep, fa.changed_at
         FROM Flight_Audit fa
         JOIN Flights f     ON f.flight_id = fa.flight_id
         LEFT JOIN Gates g1 ON g1.gate_id = fa.old_gate
         LEFT JOIN Gates g2 ON g2.gate_id = fa.new_gate
        ORDER BY fa.audit_id DESC
        LIMIT 8`
    ),
  ]);

  return Response.json({ totals: totals[0], gates, airlines, unassigned, busyCrew, lowBattery, audit });
}
