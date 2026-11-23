import { OWNER_REPORT_DAILY, UA_CBO } from "./catalog.js";

/** The one upstream every data-reading routine waits for: Fivetran/Airflow's `data.sync.completed`. */
export const DATA_SYNC = "data-sync";

export interface SystemRoutineDeclaration {
  id: string;
  /** `upstream` is a dependency node with no schedule, recipients or controls of its own. */
  kind: "routine" | "upstream";
  name: string;
  description: string;
  /** Never returned by the routines API for any viewer; consumers of it only see an anonymous upstream. */
  hidden: boolean;
  /** Ids of the system routines this one needs a result from. */
  dependsOn: readonly string[];
}

/**
 * Built-in routines as the Routines page lists them. The name and description of a registry routine come from the
 * routines catalog, so they are not repeated here. Add a routine to the page by adding one entry; `dependsOn` feeds the
 * lineage graph.
 */
export const SYSTEM_ROUTINES: readonly SystemRoutineDeclaration[] = [
  { id: DATA_SYNC, kind: "upstream", name: "Data sync", description: "Your shop and ad data loaded into Marley's warehouse.", hidden: false, dependsOn: [] },
  { id: UA_CBO, kind: "routine", name: "UA CBO recommendations", description: "", hidden: true, dependsOn: [DATA_SYNC] },
  { id: OWNER_REPORT_DAILY, kind: "routine", name: "Daily morning brief", description: "", hidden: false, dependsOn: [DATA_SYNC, UA_CBO] },
];

export const systemRoutine = (id: string): SystemRoutineDeclaration | undefined => SYSTEM_ROUTINES.find((routine) => routine.id === id);
