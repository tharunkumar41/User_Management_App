export default function Avatar({ user, size = 36 }) {
  const initials = user.name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  const style = { width: size, height: size, fontSize: size * 0.4 };
  return user.profilePicture ? (
    <img className="avatar" src={user.profilePicture} alt={user.name} style={style} referrerPolicy="no-referrer" />
  ) : (
    <span className="avatar avatar-initials" style={style} aria-label={user.name}>{initials}</span>
  );
}
