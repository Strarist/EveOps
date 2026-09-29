const categoryLabels: Record<string, string> = {
  ELECTRICAL: 'Electrical',
  HOUSE_HELP: 'House Help',
  HALL_MANAGER: 'Hall Manager',
};

export function serviceLabel(category: string) {
  return categoryLabels[category] ?? category.replaceAll('_', ' ');
}

export function activitySentence(eventType: string, actor = 'The system') {
  const who = actor || 'The system';
  switch (eventType) {
    case 'TICKET_CREATED':
      return `${who} raised this request.`;
    case 'TICKET_QUEUED':
      return 'No one was free, so this request is waiting in line.';
    case 'ASSIGNMENT_CREATED':
    case 'TICKET_ASSIGNED':
      return `${who} assigned this task.`;
    case 'ASSIGNMENT_REASSIGNED':
      return `${who} gave this task to another person.`;
    case 'STATUS_ACCEPTED':
      return `${who} accepted the task.`;
    case 'STATUS_IN_PROGRESS':
      return `${who} started the work.`;
    case 'STATUS_AWAITING_OTP':
    case 'OTP_GENERATED':
      return `${who} marked the work done. The stall now has the completion code.`;
    case 'OTP_REGENERATED':
      return 'A new completion code was prepared for the stall. The code is not shown here.';
    case 'OTP_VERIFY_FAILED':
      return `${who} entered a completion code that did not match.`;
    case 'OTP_VERIFIED':
    case 'TICKET_CLOSED':
      return `${who} checked the stall’s code and closed the request.`;
    case 'COMPLAINT_RAISED':
      return `${who} reported that the work was not satisfactory.`;
    case 'STATUS_REOPENED':
    case 'TICKET_REOPENED':
      return `${who} opened this request again.`;
    case 'ASSIGNMENT_SNOOZED':
      return `${who} will respond 10 minutes later. The task stays assigned.`;
    case 'STATUS_ESCALATED':
      return `${who} escalated this request.`;
    case 'STATUS_CANCELLED':
      return `${who} cancelled this request.`;
    case 'OVERRIDE_CLOSED':
      return `${who} closed this request with a recorded reason.`;
    case 'QUEUE_PRIORITY_OVERRIDDEN':
      return `${who} moved this request ahead in the queue and recorded a reason.`;
    case 'STAFF_PINGED':
      return `${who} sent a reminder about this task.`;
    case 'SLA_BREACHED':
      return 'The service time for this request passed.';
    case 'ASSIGNMENT_RESPONSE_OVERDUE':
      return 'The time to accept this task passed.';
    default:
      return `${who} updated this request.`;
  }
}
