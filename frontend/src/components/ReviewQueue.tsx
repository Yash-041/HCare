import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router-dom";
import { useApp } from "../app/AppContext";

/** Doctor's home: case files captured by health workers that still need verification. */
export function ReviewQueue() {
  const { db } = useApp();
  const queue = useLiveQuery(async () => {
    const drafts = (await db.consultations.toArray())
      .filter((c) => !c.deleted && c.data?.review.status === "draft")
      .sort((a, b) => a.data!.visit_date.localeCompare(b.data!.visit_date)); // oldest first
    const patients = await db.patients.bulkGet(drafts.map((c) => c.data!.patient_id));
    return drafts.map((c, i) => ({ visit: c, patient: patients[i] }));
  }, [db]);

  if (!queue) return null;
  return (
    <section className="card review-queue">
      <h3>
        Waiting for your review <span className="chip chip-pending">{queue.length}</span>
      </h3>
      {queue.length === 0 ? (
        <p className="muted small">All case files are verified.</p>
      ) : (
        <ul className="list">
          {queue.slice(0, 20).map(({ visit, patient }) => (
            <li key={visit.id}>
              <Link to={`/patients/${visit.data!.patient_id}/consultations/${visit.id}`} className="list-item">
                <div>
                  <strong>{patient?.data?.name ?? "Unknown patient"}</strong>
                  <div className="muted small">
                    {visit.data!.visit_date} · {visit.data!.chief_complaint ?? `${visit.data!.sources.length} recording(s)/document(s), not yet structured`}
                  </div>
                </div>
                <span className="chip review-draft">Review</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
