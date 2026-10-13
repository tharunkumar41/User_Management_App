import { useState } from 'react';

export default function useForm(initial) {
  const [values, setValues] = useState(initial);
  const onChange = (e) => setValues((v) => ({ ...v, [e.target.name]: e.target.value }));
  return { values, setValues, onChange };
}
