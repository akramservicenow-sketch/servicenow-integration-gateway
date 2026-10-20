/**
 * HR lifecycle event -> HR case-like record mapping.
 *
 * PII minimisation: the schema only admits an opaque employee number plus
 * organisational codes. The case references the employee by number; the
 * instance resolves the subject person from its own HR profile data, so names,
 * personal emails, dates of birth or national ids never transit the gateway.
 * @module mapping/hr
 */

/** HR service per event type. Values are HR service names configured on the instance. */
export const HR_SERVICE_BY_EVENT = {
  'employee.onboarding': 'Onboarding',
  'employee.offboarding': 'Offboarding',
  'employee.job_change': 'Job Change',
};

/** @param {any} event validated HR event */
export function toHrCaseFields(event) {
  const service = HR_SERVICE_BY_EVENT[event.event_type];
  const emp = event.employee;
  const details = [
    `Event: ${event.event_type}`,
    `Effective date: ${event.effective_date}`,
    emp.department_code ? `Department: ${emp.department_code}` : null,
    emp.location_code ? `Location: ${emp.location_code}` : null,
    emp.manager_employee_number ? `Manager employee number: ${emp.manager_employee_number}` : null,
    event.notes ? `Notes: ${event.notes}` : null,
  ].filter(Boolean);
  return {
    u_correlation_id: `hr:${event.event_id}`,
    u_hr_service_name: service,
    u_subject_employee_number: emp.employee_number,
    short_description: `${service} for employee ${emp.employee_number} effective ${event.effective_date}`,
    description: details.join('\n'),
    u_effective_date: event.effective_date,
  };
}
