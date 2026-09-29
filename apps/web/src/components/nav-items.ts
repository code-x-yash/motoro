import type { Role } from '@rr/types';
import {
  BarChart3,
  Bell,
  Car,
  Clock,
  Home,
  ListChecks,
  Plus,
  Radio,
  Scale,
  Shield,
  User,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
}

export const NAV_BY_ROLE: Record<Role, NavItem[]> = {
  DRIVER: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: Home },
    { href: '/requests/new', labelKey: 'nav.newRequest', icon: Plus },
    { href: '/history', labelKey: 'nav.history', icon: Clock },
    { href: '/vehicles', labelKey: 'nav.vehicles', icon: Car },
    { href: '/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/profile', labelKey: 'nav.profile', icon: User },
  ],
  MECHANIC: [
    { href: '/mechanic', labelKey: 'nav.offers', icon: Radio },
    { href: '/mechanic/jobs', labelKey: 'nav.jobs', icon: Wrench },
    { href: '/mechanic/earnings', labelKey: 'nav.earnings', icon: Wallet },
    { href: '/mechanic/settings', labelKey: 'nav.profile', icon: User },
    { href: '/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/profile', labelKey: 'nav.profile', icon: User },
  ],
  WORKSHOP: [
    { href: '/mechanic', labelKey: 'nav.offers', icon: Radio },
    { href: '/mechanic/jobs', labelKey: 'nav.jobs', icon: Wrench },
    { href: '/mechanic/earnings', labelKey: 'nav.earnings', icon: Wallet },
    { href: '/mechanic/settings', labelKey: 'nav.profile', icon: User },
    { href: '/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/profile', labelKey: 'nav.profile', icon: User },
  ],
  TOWING_PARTNER: [
    { href: '/mechanic', labelKey: 'nav.offers', icon: Radio },
    { href: '/mechanic/jobs', labelKey: 'nav.jobs', icon: Wrench },
    { href: '/mechanic/earnings', labelKey: 'nav.earnings', icon: Wallet },
    { href: '/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/profile', labelKey: 'nav.profile', icon: User },
  ],
  OPERATIONS: [
    { href: '/operations', labelKey: 'nav.operations', icon: Radio },
    { href: '/history', labelKey: 'nav.history', icon: Clock },
    { href: '/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/profile', labelKey: 'nav.profile', icon: User },
  ],
  ADMIN: [
    { href: '/admin', labelKey: 'nav.admin', icon: Shield },
    { href: '/admin/users', labelKey: 'nav.adminUsers', icon: ListChecks },
    { href: '/admin/pricing', labelKey: 'nav.adminPricing', icon: BarChart3 },
    { href: '/admin/payments', labelKey: 'nav.payments', icon: Wallet },
    { href: '/admin/disputes', labelKey: 'nav.adminDisputes', icon: Scale },
    { href: '/operations', labelKey: 'nav.operations', icon: Radio },
    { href: '/notifications', labelKey: 'nav.notifications', icon: Bell },
    { href: '/profile', labelKey: 'nav.profile', icon: User },
  ],
};
