import { ReactNode } from 'react';
import { useAuth, UserRole } from '../../contexts/AuthContext';

interface RoleGuardProps {
  children: ReactNode;
  allowedRoles?: UserRole[];
  requireOwner?: boolean;
  requireAdmin?: boolean;
  requireManager?: boolean;
  fallback?: ReactNode;
}

export const RoleGuard = ({
  children,
  allowedRoles,
  requireOwner = false,
  requireAdmin = false,
  requireManager = false,
  fallback = null,
}: RoleGuardProps) => {
  const { role, isOwner, isAdmin, isManager } = useAuth();

  const hasAccess = () => {
    if (requireOwner && !isOwner) return false;
    if (requireAdmin && !isAdmin && !isOwner) return false;
    if (requireManager && !isManager && !isAdmin && !isOwner) return false;
    if (allowedRoles && !allowedRoles.includes(role as UserRole)) return false;
    return true;
  };

  if (!hasAccess()) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
};
